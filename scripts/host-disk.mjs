/**
 * 真实宿主 + 真实磁盘验证
 *
 * 这是「书籍与笔记落到实际磁盘路径」这条需求的验收脚本：
 * 在官方本地宿主（dbx-plugin dev）的沙箱里导入一本书，然后**在 Node 侧**
 * 用 fs 直接检查磁盘上是否真的出现了 library.json 与 books/<id>.txt，
 * 并逐字节比对原始文件。
 *
 * 前置：
 *   npm run build
 *   npx dbx-plugin dev --path . --port 5190
 * 运行：
 *   node scripts/host-disk.mjs
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const HOST = process.env.DBX_HOST ?? 'http://127.0.0.1:5190'
const FIXTURE_DIR = resolve('ui/fixtures')

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

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
await page.goto(HOST, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: '电子书阅读器' }).click()
await page.waitForTimeout(2500)

const frame = page.frames().find((f) => f !== page.mainFrame())
check('工作台 iframe 已创建', Boolean(frame))
if (!frame) {
  await browser.close()
  process.exit(1)
}

console.log('\n[1] 后端握手')
const ping = await frame.evaluate(() => window.dbxPlugin?.invoke?.('ping').catch((e) => ({ error: String(e) })))
check('插件内可调用原生后端', ping?.ok === true, JSON.stringify(ping))
const detail = await frame.evaluate(() =>
  window.dbxPlugin?.invoke?.('storage/describe').catch((e) => ({ error: String(e) })),
)
check('拿到书库绝对路径', typeof detail?.root === 'string' && detail.root.length > 3, JSON.stringify(detail))
const root = detail?.root ?? ''
console.log(`  书库目录：${root}`)
console.log(`  数据目录：${detail?.dataDir ?? '-'}`)

console.log('\n[2] 导入一本书')
// 沙箱里 connect-src 'none'，fetch 会被拦，直接构造 File 走拖拽通道
// 内容带随机后缀：书库按内容哈希去重，重复运行必须产生新书才能验证落盘
const STAMP = Date.now().toString(36)
const SAMPLE = `第一章 山中来信\n清晨的风从山谷里穿过，带着松针的气味。\n他把书合上，听见远处传来钟声。\n${STAMP}\n`
await frame.evaluate((text) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([text], '山中来信.txt', { type: 'text/plain' }))
  document.querySelector('.app').dispatchEvent(
    new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
  )
}, SAMPLE)
await page.waitForTimeout(3000)
const cardCount = await frame.evaluate(() => document.querySelectorAll('.card').length)
check('书架出现书籍', cardCount >= 1, `cards=${cardCount}`)

console.log('\n[3] 磁盘上真的存在文件')
await page.waitForTimeout(800)
const indexFile = `${root}/library.json`
check('library.json 已写入', existsSync(indexFile), indexFile)
const booksDir = `${root}/books`
const files = existsSync(booksDir) ? readdirSync(booksDir) : []
check('books/ 下有书籍文件', files.length >= 1, files.join(','))

let recorded = null
if (existsSync(indexFile)) {
  const index = JSON.parse(readFileSync(indexFile, 'utf8'))
  check('library.json 里有书籍元信息', Array.isArray(index.books) && index.books.length >= 1, `books=${index.books?.length}`)
  const matched = (index.books ?? []).filter((book) => String(book.title).includes('山中来信'))
  matched.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
  recorded = matched[0] ?? null
  check('索引收录本次导入的书', Boolean(recorded), JSON.stringify(index.books?.map((b) => b.title)))
}
if (recorded) {
  const target = `${booksDir}/${recorded.id}.${recorded.format}`
  check('书籍文件按 id 落盘', existsSync(target), target)
  if (existsSync(target)) {
    const saved = readFileSync(target)
    check('书籍字节与原始内容一致', saved.equals(Buffer.from(SAMPLE, 'utf8')), `${saved.length} 字节`)
    console.log(`  书籍文件：${target}（${(statSync(target).size / 1024).toFixed(1)} KB）`)
    console.log(`  索引条目：${recorded.title} / ${recorded.format}`)
  }
}

console.log('\n[4] 刷新后仍从磁盘读回')
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.getByRole('button', { name: '电子书阅读器' }).click()
await page.waitForTimeout(2500)
const frame2 = page.frames().find((f) => f !== page.mainFrame())
const afterReload = await frame2.evaluate(() => ({
  cards: document.querySelectorAll('.card').length,
  warn: document.querySelector('.storage-warn')?.innerText ?? '',
}))
check('重载后书架仍有书', afterReload.cards >= 1, `cards=${afterReload.cards}`)
check('没有「仅本次会话」提示', !afterReload.warn.includes('本次会话'), afterReload.warn.slice(0, 40))

console.log('\n[5] 存储位置弹窗显示真实路径')
await frame2.getByRole('button', { name: '存储位置' }).first().click()
await page.waitForTimeout(900)
const shown = await frame2.evaluate(() => ({
  path: document.querySelector('.dialog .current strong')?.textContent ?? '',
  hasInput: Boolean(document.querySelector('#storage-root')),
  hasBrowse: [...document.querySelectorAll('.dialog button')].some(
    (button) => (button.textContent ?? '').includes('浏览') && !button.disabled,
  ),
  text: document.body.innerText.replace(/\s+/g, ' '),
}))
check('弹窗显示磁盘绝对路径', shown.path === root, shown.path)
check('提供路径输入框', shown.hasInput)
check('提供「浏览…」选择文件夹入口', shown.hasBrowse)
check('模式列表含「本机磁盘」', shown.text.includes('本机磁盘'), shown.text.slice(0, 60))

await browser.close()
rmSync(FIXTURE_DIR, { recursive: true, force: true })

console.log(failed === 0 ? '\nPASS host-disk' : `\nFAILED ${failed}`)
process.exit(failed === 0 ? 0 : 1)
