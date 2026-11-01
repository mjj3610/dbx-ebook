/**
 * 端到端冒烟测试
 * 说明：Playwright 的 setInputFiles 注入的文件在 change 事件内无法立即读取（CDP 时序限制），
 * 因此这里改用 DataTransfer 构造 File 并触发 drop，等价于用户真实拖拽导入。
 * 运行：先 `npm run build`，再 `npx vite preview --port 4173`（预览 ui/ 产物），最后 `node scripts/e2e.mjs`
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'
import { cpSync, rmSync, existsSync } from 'node:fs'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const BASE = process.env.E2E_BASE ?? 'http://localhost:4173'
const FIXTURE_DIR = resolve('ui/fixtures')

const errors = []
let failed = 0

/** 断言 */
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

// 将样本复制到预览目录，供页面通过 fetch 读取
if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true })
cpSync('fixtures', FIXTURE_DIR, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('404')) errors.push(`console: ${message.text()}`)
})

await page.goto(BASE, { waitUntil: 'networkidle' })

/** 通过 drop 导入指定文件 */
async function dropFiles(names) {
  await page.evaluate(async (list) => {
    const transfer = new DataTransfer()
    for (const name of list) {
      const response = await fetch(`/fixtures/${name}`)
      const blob = await response.blob()
      transfer.items.add(new File([blob], name))
    }
    const target = document.querySelector('.app')
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  }, names)
}

console.log('\n[1] 书架与导入')
check('书架首屏渲染', await page.locator('.shelf').isVisible())
await dropFiles([
  'novel.txt',
  'book.epub',
  'comic.cbz',
  'doc.pdf',
  'multi.pdf',
  'cn.pdf',
  'gbk-txt.txt',
  'gbk-epub.epub',
  'ru.fb2',
  'cp936.rtf',
])
await page.waitForSelector('.card', { timeout: 20000 })
await page.waitForTimeout(1500)
const cardCount = await page.locator('.card').count()
check('导入 10 本书', cardCount === 10, `实际 ${cardCount}`)

/** 打开指定书籍 */
async function openBook(title) {
  await page.locator('.card', { hasText: title }).first().click()
  await page.waitForSelector('.reader', { timeout: 10000 })
  await page.waitForTimeout(900)
}

/** 读取文字流正文 */
const readShadowText = () =>
  page.evaluate(() => {
    const host = document.querySelector('.page-host')
    return host?.shadowRoot?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })

console.log('\n[2] TXT 阅读与分页')
await openBook('novel')
const txtText = await readShadowText()
check('正文渲染成功', txtText.includes('清晨的风'), txtText.slice(0, 40))
const labels = await page.locator('.labels').innerText()
check('进度信息存在', labels.includes('%'), labels)
await page.locator('.footer .nav').last().click()
await page.waitForTimeout(500)
check('翻页无异常', (await page.locator('.flow-reader').count()) === 1)

console.log('\n[3] 阅读模式切换')
await page.locator('.right .icon-btn').nth(3).click()
await page.waitForTimeout(400)
check('设置面板打开', await page.locator('.panel').isVisible())
await page.locator('.segmented button', { hasText: '双页' }).click()
await page.waitForTimeout(600)
check('双页模式生效', (await page.locator('.flow-reader.mode-double').count()) === 1)
await page.locator('.segmented button', { hasText: '滚动' }).click()
await page.waitForTimeout(900)
check('滚动模式生效', (await page.locator('.scroller').count()) === 1)
check('滚动模式挂载正文', (await page.locator('.scroller .scroll-chapter').count()) >= 3)
await page.locator('.segmented button', { hasText: '单页' }).click()
await page.waitForTimeout(700)
await page.locator('.panel .icon-btn').last().click()
await page.waitForTimeout(400)

console.log('\n[4] 选中与高亮')
await page.evaluate(() => {
  const host = document.querySelector('.page-host')
  const root = host?.shadowRoot
  const paragraph = root?.querySelector('.book p')
  if (!paragraph || !paragraph.firstChild) {
    // 回退：选中第一个有文本的元素
    const candidate = root?.querySelector('.book h1, .book p')
    if (!candidate || !candidate.firstChild) return
  }
  const node = (root?.querySelector('.book p') ?? root?.querySelector('.book h1'))
  const textNode = node?.firstChild
  if (!textNode) return
  const range = document.createRange()
  range.setStart(textNode, 0)
  range.setEnd(textNode, Math.min(6, textNode.textContent.length))
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
})
await page.waitForTimeout(600)
const barVisible = await page.locator('.bar').isVisible()
check('选中浮条出现', barVisible)
if (barVisible) {
  await page.locator('.bar .dot').first().click()
  await page.waitForTimeout(700)
  const markCount = await page.evaluate(() => {
    const root = document.querySelector('.page-host')?.shadowRoot
    return root ? root.querySelectorAll('mark[data-note-id]').length : 0
  })
  check('高亮写入正文', markCount > 0, `mark=${markCount}`)
  await page.locator('.right .icon-btn').nth(1).click()
  await page.waitForTimeout(500)
  const noteCount = await page.locator('.note').count()
  check('笔记面板记录高亮', noteCount > 0, `notes=${noteCount}`)
  await page.locator('.panel .icon-btn').last().click()
}

/** 返回书架 */
async function backToShelf() {
  await page.locator('.topbar .left .icon-btn').click()
  await page.waitForSelector('.shelf', { timeout: 8000 })
  await page.waitForTimeout(500)
}

console.log('\n[5] EPUB')
await backToShelf()
await openBook('测试之书')
const epubText = await readShadowText()
check('EPUB 正文渲染', epubText.includes('光从东边'), epubText.slice(0, 50))
const epubStyle = await page.evaluate(() => {
  const root = document.querySelector('.page-host')?.shadowRoot
  return root?.querySelector('style')?.textContent?.includes('text-indent') ?? false
})
check('EPUB 样式注入', epubStyle)
const imgOk = await page.evaluate(() => {
  const root = document.querySelector('.page-host')?.shadowRoot
  const img = root?.querySelector('.book img')
  return img ? (img.src.startsWith('blob:') ? 'blob' : img.src.slice(0, 12)) : 'none'
})
check('EPUB 图片重写为 blob', imgOk === 'blob', imgOk)
await page.locator('.right .icon-btn').first().click()
await page.waitForTimeout(400)
const tocItems = await page.locator('.toc-item').count()
check('EPUB 目录解析', tocItems >= 2, `items=${tocItems}`)
await page.locator('.panel .icon-btn').last().click()

console.log('\n[6] PDF')
await backToShelf()
await page.locator('.card', { hasText: 'doc' }).first().click()
await page.waitForTimeout(3000)
const canvasSize = await page.evaluate(() => {
  const canvas = document.querySelector('.page-canvas')
  return canvas ? `${canvas.width}x${canvas.height}` : ''
})
check('PDF 画布渲染', canvasSize !== '' && !canvasSize.startsWith('0x'), canvasSize)
const pdfText = await page.evaluate(() => document.querySelector('.text-layer')?.textContent ?? '')
check('PDF 文本层可用', pdfText.includes('Sample'), pdfText.slice(0, 40))

console.log('\n[6b] 中文 PDF（CMap 内联）')
await backToShelf()
await page.locator('.card', { hasText: 'cn' }).first().click()
await page.waitForTimeout(4000)
const cnCanvas = await page.evaluate(() => {
  const canvas = document.querySelector('.page-canvas')
  return canvas ? `${canvas.width}x${canvas.height}` : ''
})
check('中文 PDF 画布渲染', cnCanvas !== '' && !cnCanvas.startsWith('0x'), cnCanvas)
const cnText = await page.evaluate(() => document.querySelector('.text-layer')?.textContent ?? '')
check('中文 PDF 文本层无乱码', cnText.includes('电子书阅读器'), JSON.stringify(cnText.slice(0, 30)))
check('中文标点正确', cnText.includes('《测试》'), JSON.stringify(cnText.slice(0, 60)))
check('文本层不含替换符', !/[\uFFFD]/.test(cnText), cnText.slice(0, 30))

console.log('\n[6c] PDF 翻页控件')
await backToShelf()
// multi.pdf 内嵌了 Word 风格的旧标题（Microsoft Word - Legacy Title.docx），书名必须仍取文件名
const multiCardTitle = (await page.locator('.card', { hasText: 'multi' }).first().locator('.meta h3').innerText().catch(() => '')).trim()
check('PDF 书名取文件名而非内嵌元数据', multiCardTitle === 'multi', multiCardTitle || '(读不到卡片标题)')
await openBook('multi')
/** 从底部进度读当前页 */
const readPageNo = async () => {
  const text = await page.locator('.labels').innerText()
  const matched = /(\d+)\s*\/\s*(\d+)/.exec(text)
  return matched ? Number(matched[1]) : Number.NaN
}
check('分页模式出现左右翻页按钮', (await page.locator('.pager-next').isVisible()) && (await page.locator('.pager-prev').isVisible()))
check('首屏「上一页」按钮禁用', await page.locator('.pager-prev').isDisabled())
const pageStart = await readPageNo()
await page.locator('.pager-next').click()
await page.waitForTimeout(900)
const pageAfterNext = await readPageNo()
check('单页模式点「下一页」前进 1 页', pageAfterNext === pageStart + 1, `${pageStart} -> ${pageAfterNext}`)
await page.locator('.pager-prev').click()
await page.waitForTimeout(900)
check('点「上一页」回到原页', (await readPageNo()) === pageStart, `当前 ${await readPageNo()}`)

await page.locator('.right .icon-btn').nth(3).click()
await page.waitForTimeout(400)
await page.locator('.segmented button', { hasText: '双页' }).click()
await page.waitForTimeout(700)
// 设置面板会盖住右侧翻页按钮，先关掉再点
await page.locator('.panel .icon-btn').last().click()
await page.waitForTimeout(600)
// 双页不能只多出一个空壳：两页要真的并排在同一行，且各自的画布都画出了内容
const doubleLayout = await page.evaluate(() => {
  const viewport = document.querySelector('.pages-viewport')
  const boxes = Array.from(document.querySelectorAll('.page-shell')).map((el) => el.getBoundingClientRect())
  const canvases = Array.from(document.querySelectorAll('.page-canvas')).map((el) => el.width)
  return {
    count: boxes.length,
    tops: boxes.map((box) => Math.round(box.top)),
    lefts: boxes.map((box) => Math.round(box.left)),
    right: boxes.length ? Math.round(boxes[boxes.length - 1].right) : 0,
    viewportWidth: viewport ? Math.round(viewport.clientWidth) : 0,
    canvases,
  }
})
check('双页模式并排显示 2 页', doubleLayout.count === 2, `shells=${doubleLayout.count}`)
check(
  '第 2 页未换行到下一行',
  doubleLayout.tops.length === 2 && doubleLayout.tops[0] === doubleLayout.tops[1],
  `tops=${doubleLayout.tops.join(',')}`,
)
check(
  '两页横坐标不同且都在视口内',
  doubleLayout.lefts.length === 2 &&
    doubleLayout.lefts[0] !== doubleLayout.lefts[1] &&
    doubleLayout.right <= doubleLayout.viewportWidth + 1,
  `lefts=${doubleLayout.lefts.join(',')} right=${doubleLayout.right} 视口=${doubleLayout.viewportWidth}`,
)
check(
  '两页画布都已绘制',
  doubleLayout.canvases.length === 2 && doubleLayout.canvases.every((width) => width > 0),
  `canvas 宽=${doubleLayout.canvases.join(',')}`,
)
await page.locator('.pager-next').click()
await page.waitForTimeout(1000)
const pageDouble = await readPageNo()
check('双页模式点「下一页」前进 2 页', pageDouble >= pageStart + 2, `${pageStart} -> ${pageDouble}`)
await page.locator('.right .icon-btn').nth(3).click()
await page.waitForTimeout(400)
await page.locator('.segmented button', { hasText: '单页' }).click()
await page.waitForTimeout(600)
await page.locator('.panel .icon-btn').last().click()
await page.waitForTimeout(400)

console.log('\n[7] 漫画')
await backToShelf()
await page.locator('.card', { hasText: 'comic' }).first().click()
await page.waitForTimeout(1500)
const comicImgs = await page.locator('.comic-img').count()
check('漫画页渲染', comicImgs >= 1, `imgs=${comicImgs}`)

console.log('\n[7b] 编码兼容（GBK / windows-1251 / RTF 码表）')
await backToShelf()
await openBook('gbk-txt')
const gbkTxt = await readShadowText()
check('GB18030 TXT 正文正确', gbkTxt.includes('清晨的风从山谷里穿过'), gbkTxt.slice(0, 30))
check('GB18030 TXT 无替换符', !gbkTxt.includes('\ufffd'), gbkTxt.slice(0, 30))

await backToShelf()
await openBook('GBK 编码之书')
const gbkEpubText = await readShadowText()
check('GBK EPUB 正文正确', gbkEpubText.includes('竹叶在风里翻了个身'), gbkEpubText.slice(0, 40))

await backToShelf()
await openBook('Тестовая книга')
const ruText = await readShadowText()
check('windows-1251 FB2 正文正确', ruText.includes('Утро было тихим'), ruText.slice(0, 40))

await backToShelf()
await openBook('cp936')
const rtfText = await readShadowText()
check('RTF \\ansicpg936 中文正确', rtfText.includes('山间的清晨'), rtfText.slice(0, 40))
check('RTF \\uN 转义正确', rtfText.includes('江河'), rtfText.slice(0, 40))

console.log('\n[8] 备份导出')
await backToShelf()
await page.locator('.tools .btn-backup').click()
await page.waitForTimeout(500)
check('备份弹窗打开', await page.locator('.dialog').isVisible())
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
  page.locator('.dialog .btn-ghost', { hasText: '导出数据' }).first().click(),
])
check('导出数据文件', Boolean(download), download ? download.suggestedFilename() : '无下载')

console.log('\n[9] 控制台错误')
errors.slice(0, 8).forEach((item) => console.log(`  ! ${item}`))
check('无运行时错误', errors.length === 0, `${errors.length} 条`)

await browser.close()
rmSync(FIXTURE_DIR, { recursive: true, force: true })
console.log(`\n结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
