/**
 * Sidecar 协议与落盘行为校验（不依赖 DBX 宿主）
 *
 * 直接以 JSON Lines 协议驱动 bin/backend-dev.exe，验证：
 *   1. plugin/initialize 握手
 *   2. storage/describe、library 读写
 *   3. 书籍分块写入 / 分块读回（字节一致）
 *   4. book/stat、book/delete、book/list
 *   5. storage/setRoot 换目录并把旧数据迁过去
 *   6. 非法文件名被拒（路径穿越防护）
 *
 * 用法：先 `node scripts/build-backend.mjs`，再 `node scripts/sidecar-check.mjs`
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = process.env.SIDECAR_BIN ?? join('bin', process.platform === 'win32' ? 'backend-dev.exe' : 'backend-dev')

if (!existsSync(BIN)) {
  console.error(`找不到 Sidecar 二进制：${BIN}（先运行 node scripts/build-backend.mjs）`)
  process.exit(1)
}

let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'dbx-ebook-data-'))
const externalDir = mkdtempSync(join(tmpdir(), 'dbx-ebook-lib-'))

const child = spawn(BIN, [], {
  env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (chunk) => process.env.SIDECAR_DEBUG && process.stderr.write(chunk))

const pending = new Map()
let nextId = 0
const rl = createInterface({ input: child.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const resolver = pending.get(message.id)
  if (!resolver) return
  pending.delete(message.id)
  if (message.error) resolver.reject(new Error(`${message.error.code}: ${message.error.message}`))
  else resolver.resolve(message.result)
})

function call(method, params = {}) {
  nextId += 1
  const id = nextId
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(`${payload}\n`)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`超时：${method}`))
      }
    }, 10000)
  })
}

console.log('\n[1] 握手')
const init = await call('plugin/initialize', { host: { protocolVersions: [1] } })
check('initialize 返回协议版本', init?.protocolVersion === 1, JSON.stringify(init))
check('initialize 回传插件 id', init?.plugin?.id === 'com.csisolar.ebook', JSON.stringify(init?.plugin))
check('ping 可用', (await call('ping')).ok === true)

console.log('\n[2] 存储描述')
let info = await call('storage/describe')
check('默认根目录在插件数据目录下', info.root.startsWith(dataDir), info.root)
check('标记为默认位置', info.isDefault === true)
check('目录可写', info.writable === true)
check('暴露平台信息', typeof info.platform === 'string', info.platform)

console.log('\n[3] 书库索引')
check('初始无索引', (await call('library/read')).exists === false)
const payload = JSON.stringify({ version: 1, books: [{ id: 'b1', title: '测试' }], notes: [] })
const written = await call('library/write', { json: payload })
check('写入索引返回字节数', written.size === Buffer.byteLength(payload), String(written.size))
const reread = await call('library/read')
check('读回内容一致', reread.json === payload)
check('索引落在真实磁盘', existsSync(join(info.root, 'library.json')))

console.log('\n[4] 书籍分块读写')
const big = Buffer.alloc(900 * 1024)
for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + 7) & 0xff
const CHUNK = 400 * 1024
let offset = 0
let lastSize = 0
while (offset < big.length) {
  const slice = big.subarray(offset, Math.min(offset + CHUNK, big.length))
  const res = await call('book/write', {
    name: 'b1.epub',
    offset,
    dataBase64: slice.toString('base64'),
    truncate: offset === 0,
  })
  lastSize = res.size
  offset += slice.length
}
check('分块写入后文件大小正确', lastSize === big.length, `${lastSize} vs ${big.length}`)
const onDisk = readFileSync(join(info.root, 'books', 'b1.epub'))
check('磁盘字节完全一致', Buffer.compare(onDisk, big) === 0)

let readOffset = 0
const collected = []
for (;;) {
  const chunk = await call('book/read', { name: 'b1.epub', offset: readOffset, length: 256 * 1024 })
  if (!chunk.exists) break
  collected.push(Buffer.from(chunk.dataBase64, 'base64'))
  readOffset = chunk.nextOffset
  if (chunk.eof) break
}
check('分块读回字节一致', Buffer.compare(Buffer.concat(collected), big) === 0)

const stat = await call('book/stat', { name: 'b1.epub' })
check('stat 返回真实路径', stat.exists && stat.path.endsWith('b1.epub'), stat.path)
check('book/list 列出文件', (await call('book/list')).books.some((b) => b.name === 'b1.epub'))

console.log('\n[5] 换目录与迁移')
info = await call('storage/setRoot', { path: externalDir })
check('切换到自定义目录', info.root === externalDir, info.root)
check('不再标记默认位置', info.isDefault === false)
check('迁移了索引', existsSync(join(externalDir, 'library.json')))
check('迁移了书籍', existsSync(join(externalDir, 'books', 'b1.epub')))
check('迁移计数大于 0', info.migrated > 0, String(info.migrated))
check('迁移后仍能读回索引', (await call('library/read')).json === payload)

const reset = await call('storage/resetRoot')
check('可切回默认目录', reset.root === join(dataDir, 'library'), reset.root)

console.log('\n[6] 安全校验')
let traverseBlocked = false
try {
  await call('book/write', { name: '../evil.txt', offset: 0, dataBase64: 'aGk=', truncate: true })
} catch {
  traverseBlocked = true
}
check('拒绝路径穿越文件名', traverseBlocked)
check('拒绝相对路径根目录', await call('storage/setRoot', { path: 'relative/dir' }).then(() => false, () => true))

console.log('\n[7] 删除')
await call('book/delete', { name: 'b1.epub' })
check('删除后文件不存在', !existsSync(join(dataDir, 'library', 'books', 'b1.epub')))

console.log('\n[8] 目录浏览（选择文件夹用）')
const home = await call('storage/listDirs', {})
check('不传路径时返回盘符/根', Array.isArray(home.roots) && home.roots.length > 0, JSON.stringify(home.roots ?? []).slice(0, 60))
check('不传路径时返回快捷位置', Array.isArray(home.shortcuts) && home.shortcuts.length > 0)
check('快捷位置包含当前书库', (home.shortcuts ?? []).some((item) => item.key === 'library'))

const listing = await call('storage/listDirs', { path: dataDir })
check('可以列出插件数据目录', listing.path === dataDir, listing.path)
check('列表只含目录', Array.isArray(listing.entries))
check('可写标记为真', listing.writable === true)

const made = await call('storage/mkdir', { parent: dataDir, name: 'picker-demo' })
check('可以新建文件夹', existsSync(made.path), made.path)
const inside = await call('storage/listDirs', { path: dataDir })
check('新文件夹出现在列表里', (inside.entries ?? []).some((item) => item.name === 'picker-demo'))

let rejected = false
try {
  await call('storage/mkdir', { parent: dataDir, name: '../escape' })
} catch {
  rejected = true
}
check('拒绝带路径分隔符的文件夹名', rejected)

let relativeRejected = false
try {
  await call('storage/listDirs', { path: 'relative/dir' })
} catch {
  relativeRejected = true
}
check('拒绝相对路径', relativeRejected)

child.kill()
rmSync(dataDir, { recursive: true, force: true })
rmSync(externalDir, { recursive: true, force: true })

console.log(failed === 0 ? '\nPASS sidecar-check' : `\nFAILED ${failed}`)
process.exit(failed === 0 ? 0 : 1)
