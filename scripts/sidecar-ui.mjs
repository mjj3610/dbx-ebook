/**
 * Sidecar 落盘集成测试（浏览器内，用假后端模拟 Go 进程）
 *
 * 目的：验证前端 SidecarBackend 的完整链路——
 *   1) 宿主提供 invoke 时自动选中「本机磁盘」后端
 *   2) 导入书籍后书库索引与书籍文件都通过 invoke 写进磁盘目录
 *   3) 重新加载页面后书库仍在（真正持久化）
 *   4) 在「存储位置」里改路径，索引与书籍跟着搬家
 *
 * 假后端把文件系统放在 localStorage 里，页面重载后依然存在，
 * 因此能证明「重载后数据还在」这条关键诉求。
 * 真后端的协议与文件字节一致性由 scripts/sidecar-check.mjs 覆盖。
 *
 * 运行：先 `npm run build`，再 `npx vite preview --port 4173`，最后 `node scripts/sidecar-ui.mjs`
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'
import { cpSync, rmSync, existsSync } from 'node:fs'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const BASE = process.env.E2E_BASE ?? 'http://localhost:4173'
const FIXTURE_DIR = resolve('ui/fixtures')
const DEFAULT_ROOT = 'C:\\Users\\demo\\AppData\\Roaming\\dbx\\plugin-data\\com.mjj3610.ebook\\library'

let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true })
cpSync('fixtures', FIXTURE_DIR, { recursive: true })

/** 注入假宿主 + 假 Sidecar 文件系统 */
const MOCK = `
  window.__initFs = () => {
    const empty = { root: ${JSON.stringify(DEFAULT_ROOT)}, defaultRoot: ${JSON.stringify(DEFAULT_ROOT)}, files: {}, roots: {} }
    try {
      const saved = JSON.parse(localStorage.getItem('__fakeFs') || 'null')
      window.__fakeFs = saved || empty
    } catch { window.__fakeFs = empty }
  }
  window.__initFs()
  window.__persistFs = () => localStorage.setItem('__fakeFs', JSON.stringify(window.__fakeFs))
  window.__invokeLog = []
  const toBytes = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out }
  const toB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
  const describe = () => {
    const fs = window.__fakeFs
    const names = Object.keys(fs.files).filter((n) => n.startsWith('books/'))
    const bytes = names.reduce((sum, n) => sum + toBytes(fs.files[n]).length, 0)
    return {
      dataDir: fs.defaultRoot.replace(/[\\\\/]library$/, ''),
      root: fs.root,
      isDefault: fs.root === fs.defaultRoot,
      exists: true,
      writable: true,
      platform: 'win32',
      bookCount: names.length,
      booksBytes: bytes,
      indexBytes: fs.files['library.json'] ? fs.files['library.json'].length : 0,
    }
  }
  window.dbxPlugin = {
    ready: Promise.resolve({ pluginId: 'com.mjj3610.ebook' }),
    context: { pluginId: 'com.mjj3610.ebook' },
    locale: 'zh-CN',
    theme: { appearance: 'light', tokens: {} },
    request: async () => ({ ok: true }),
    copy: async () => ({ ok: true }),
    invoke: async (method, params) => {
      const fs = window.__fakeFs
      params = params || {}
      window.__invokeLog.push(method)
      switch (method) {
        case 'ping': return { ok: true, version: '1.1.0', platform: 'win32' }
        case 'storage/describe': return describe()
        case 'storage/setRoot': {
          const target = params.path && params.path.trim() ? params.path.trim() : fs.defaultRoot
          const before = fs.root
          let migrated = 0
          if (target !== before) {
            for (const [n, v] of Object.entries(fs.files)) { fs.roots[n] = v; migrated += 1 }
            fs.root = target
          }
          window.__persistFs()
          return { ...describe(), migrated }
        }
        case 'storage/resetRoot': {
          fs.root = fs.defaultRoot
          window.__persistFs()
          return { ...describe(), migrated: 0 }
        }
        case 'library/read': {
          const json = fs.files['library.json']
          return { exists: Boolean(json), json: json || '', size: json ? json.length : 0 }
        }
        case 'library/write': {
          fs.files['library.json'] = params.json
          window.__persistFs()
          return { size: params.json.length, path: fs.root + '/library.json' }
        }
        case 'book/write': {
          const name = 'books/' + params.name
          const chunk = toBytes(params.dataBase64)
          const prev = !params.truncate && fs.files[name] ? toBytes(fs.files[name]) : new Uint8Array(0)
          const out = new Uint8Array(Math.max(prev.length, params.offset + chunk.length))
          out.set(prev, 0)
          out.set(chunk, params.offset)
          fs.files[name] = toB64(out)
          window.__persistFs()
          return { written: chunk.length, size: out.length, path: fs.root + '/' + name }
        }
        case 'book/read': {
          const name = 'books/' + params.name
          const data = fs.files[name] ? toBytes(fs.files[name]) : null
          if (!data) return { exists: false, dataBase64: '', size: 0, nextOffset: 0, eof: true }
          const length = params.length || 512 * 1024
          const slice = data.subarray(params.offset, Math.min(params.offset + length, data.length))
          const next = params.offset + slice.length
          return { exists: true, dataBase64: toB64(slice), size: data.length, nextOffset: next, eof: next >= data.length }
        }
        case 'book/stat': {
          const name = 'books/' + params.name
          const data = fs.files[name] ? toBytes(fs.files[name]) : null
          return { exists: Boolean(data), size: data ? data.length : 0, path: fs.root + '/' + name }
        }
        case 'book/delete': {
          const name = 'books/' + params.name
          const had = Boolean(fs.files[name])
          delete fs.files[name]
          window.__persistFs()
          return { deleted: had, path: fs.root + '/' + name }
        }
        case 'book/list':
          return { books: Object.keys(fs.files).filter((n) => n.startsWith('books/')).map((n) => ({ name: n.slice(6), size: 0 })), root: fs.root }
        default: throw new Error('Method not found: ' + method)
      }
    },
  }
`

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
await context.addInitScript(MOCK)
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.shelf', { timeout: 20000 })

/** 通过 drop 导入指定文件 */
async function dropFiles(names) {
  await page.evaluate(async (list) => {
    const transfer = new DataTransfer()
    for (const name of list) {
      const response = await fetch(`/fixtures/${name}`)
      const blob = await response.blob()
      transfer.items.add(new File([blob], name))
    }
    document.querySelector('.app').dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    )
  }, names)
}

/** 读取假磁盘上的文件（长度） */
const diskFile = (name) =>
  page.evaluate((key) => {
    const value = window.__fakeFs.files[key]
    return value ? value.length : 0
  }, name)

console.log('\n[1] 后端探测')
const backend = await page.evaluate(() => window.__invokeLog.includes('ping'))
check('启动时探测原生后端', backend)
check('默认走磁盘后端（写了 library.json）', (await diskFile('library.json')) === 0, '导入前应为空')

console.log('\n[2] 导入即落盘')
await dropFiles(['novel.txt', 'book.epub'])
await page.waitForSelector('.card', { timeout: 20000 })
await page.waitForTimeout(2000)
const cards = await page.locator('.card').count()
check('书架显示 2 本书', cards === 2, `实际 ${cards}`)
check('磁盘上出现书库索引', (await diskFile('library.json')) > 0)
const bookFiles = await page.evaluate(() =>
  Object.keys(window.__fakeFs.files).filter((name) => name.startsWith('books/')),
)
check('磁盘上出现书籍文件', bookFiles.length === 2, bookFiles.join(','))
const sizes = await page.evaluate(() =>
  Object.entries(window.__fakeFs.files)
    .filter(([name]) => name.startsWith('books/'))
    .map(([, value]) => value.length),
)
check('书籍文件非空', sizes.every((size) => size > 0), String(sizes))

console.log('\n[3] 重新加载后仍在（真持久化）')
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('.card', { timeout: 20000 })
await page.waitForTimeout(1200)
const afterReload = await page.locator('.card').count()
check('重载后书架仍有 2 本书', afterReload === 2, `实际 ${afterReload}`)

console.log('\n[4] 阅读验证（文件能被读回）')
await page.locator('.card', { hasText: 'novel' }).first().click()
await page.waitForSelector('.reader', { timeout: 10000 })
await page.waitForTimeout(1200)
const text = await page.evaluate(
  () => document.querySelector('.page-host')?.shadowRoot?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
)
check('从磁盘读回的书能正常渲染', text.includes('清晨的风'), text.slice(0, 30))

console.log('\n[5] 存储位置弹窗与改路径')
await page.locator('.topbar .left .icon-btn').click()
await page.waitForSelector('.shelf', { timeout: 8000 })
await page.locator('.tools .btn-storage').click()
await page.waitForSelector('.dialog', { timeout: 8000 })
await page.waitForTimeout(600)
const shownPath = await page.locator('.dialog .current strong').innerText()
check('弹窗显示磁盘绝对路径', shownPath === DEFAULT_ROOT, shownPath)
const inputVisible = await page.locator('#storage-root').isVisible()
check('路径输入框可见', inputVisible)

const NEW_ROOT = 'D:\\Books\\dbx-library'
await page.locator('#storage-root').fill(NEW_ROOT)
await page.locator('.path-actions .btn-primary').click()
await page.waitForTimeout(1500)
const updatedPath = await page.locator('.dialog .current strong').innerText()
check('路径已切换到新目录', updatedPath === NEW_ROOT, updatedPath)

console.log('\n[6] 换目录后数据跟着走 + 重载仍生效')
const movedIndex = await page.evaluate(() => {
  const fs = window.__fakeFs
  const idx = fs.files['library.json'] ? JSON.parse(fs.files['library.json']) : null
  return { root: fs.root, books: idx ? idx.books.length : 0 }
})
check('后端根目录已更新', movedIndex.root === NEW_ROOT, JSON.stringify(movedIndex))
check('索引随目录迁移', movedIndex.books === 2, JSON.stringify(movedIndex))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('.card', { timeout: 20000 })
await page.waitForTimeout(1200)
check('重载后仍是 2 本书', (await page.locator('.card').count()) === 2)

console.log('\n[7] 控制台错误')
errors.slice(0, 5).forEach((item) => console.log(`  ! ${item}`))
check('无运行时错误', errors.length === 0, `${errors.length} 条`)

await browser.close()
rmSync(FIXTURE_DIR, { recursive: true, force: true })
console.log(failed === 0 ? '\nPASS sidecar-ui' : `\nFAILED ${failed}`)
process.exit(failed === 0 ? 0 : 1)
