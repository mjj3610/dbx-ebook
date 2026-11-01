/**
 * 真实宿主沙箱内的 PDF 渲染诊断
 *
 * 浏览器预览（vite preview）没有宿主 CSP 与 origin=null 的限制，
 * 因此乱码问题必须在真实宿主里查。本脚本在沙箱里导入 PDF 并核对：
 *   1) 文本层文字（乱码会体现在这里）
 *   2) 画布墨迹比例（字形是否真的画出来了）
 *   3) CMap 告警（缺 CMap 必然乱码；系统字体缺失属另一类，单独报告）
 *
 * 每次运行都用独立的空书库，避免内容哈希去重导致样本「导入即被跳过」。
 *
 * 前置：npm run build && npx dbx-plugin dev --path . --port 5191
 * 运行：DBX_HOST=http://127.0.0.1:5191 node scripts/host-pdf.mjs
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync } from 'node:fs'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const HOST = process.env.DBX_HOST ?? 'http://127.0.0.1:5191'
const SHOTS = resolve('screenshots')
const FIXTURE_DIR = resolve('ui/fixtures')
mkdirSync(SHOTS, { recursive: true })

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

/**
 * 待测 PDF：本地样本（可传参追加真实书）
 *
 * 每份样本在 %%EOF 之后追加一行唯一注释：书的去重是按内容哈希做的，
 * 不这么做第二次运行就会「已存在同名内容」直接跳过，测不到渲染。
 * 尾部注释对 pdf.js 无影响（startxref 仍在尾部扫描窗口内）。
 */
const TAIL_TAG = `\n% dbx-ebook-test-${Date.now().toString(36)}\n`
const PDFS = (process.env.PDF_FILES ?? 'cn.pdf,doc.pdf')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)
  .map((name) => ({
    name,
    base64: Buffer.concat([readFileSync(resolve('fixtures', name)), Buffer.from(TAIL_TAG, 'latin1')]).toString('base64'),
  }))

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
const logs = []
page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`))
page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`))

await page.goto(HOST, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: '电子书阅读器' }).click()
await page.waitForTimeout(3000)
const frame = page.frames().find((f) => f !== page.mainFrame())
check('工作台 iframe 已创建', Boolean(frame))
if (!frame) {
  await browser.close()
  rmSync(TEST_ROOT, { recursive: true, force: true })
  process.exit(1)
}

const env = await frame.evaluate(() => ({ origin: location.origin }))
console.log(`  环境：origin=${env.origin}`)

/** 导入一个 PDF（沙箱内不能 fetch，用字节直接构造 File） */
async function importPdf(item) {
  const bytes = [...Buffer.from(item.base64, 'base64')]
  await frame.evaluate(
    ({ bytes, name }) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }))
      document.querySelector('.app').dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      )
    },
    { bytes, name: item.name },
  )
  await page.waitForTimeout(4000)
}

/** 等书名卡片出现（导入是异步的，慢的大文件要给足时间） */
async function waitForCard(title, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await frame.evaluate((wanted) => {
      return [...document.querySelectorAll('.card')].some((card) => (card.textContent ?? '').includes(wanted))
    }, title)
    if (found) return true
    await page.waitForTimeout(500)
  }
  return false
}

for (const item of PDFS) {
  console.log(`\n[${item.name}] 导入`)
  logs.length = 0
  await importPdf(item)

  const title = item.name.replace(/\.pdf$/i, '')
  const onShelf = await waitForCard(title)
  check('书架上有这本 PDF', onShelf, title)
  if (!onShelf) continue

  await frame.evaluate((wanted) => {
    const target = [...document.querySelectorAll('.card')].find((card) => (card.textContent ?? '').includes(wanted))
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, title)
  await page.waitForTimeout(5000)

  const state = await frame.evaluate(() => {
    const canvas = document.querySelector('.page-canvas')
    const layer = document.querySelector('.text-layer')
    let ink = 0
    let size = ''
    if (canvas) {
      size = `${canvas.width}x${canvas.height}`
      const context = canvas.getContext('2d')
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let painted = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) painted += 1
      }
      ink = painted / (data.length / 4)
    }
    return {
      canvasSize: size,
      ink: Number(ink.toFixed(4)),
      text: (layer?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      pageError: document.querySelector('.page-error')?.textContent ?? '',
      docError: document.querySelector('.doc-error')?.textContent ?? '',
    }
  })

  // 真实书可能是证件/合同，只打印字符类别统计，不回显原文
  const cjk = (state.text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const latin = (state.text.match(/[A-Za-z]/g) ?? []).length
  const replacement = (state.text.match(/[\ufffd]/g) ?? []).length
  console.log(
    `  画布=${state.canvasSize} 墨迹=${state.ink} 文本层字符=${state.text.length}（汉字 ${cjk} / 拉丁 ${latin} / 替换符 ${replacement}）`,
  )
  check('画布有内容（不是空白页）', state.ink > 0.002, `ink=${state.ink}`)
  check('没有整页渲染失败提示', !state.pageError && !state.docError, state.pageError || state.docError)
  check('文本层不是乱码/替换符', replacement === 0, `替换符 ${replacement} 个`)

  // 扫描件本来就没有文本层，只对自带文字的样本要求可读
  const expectText = item.name === 'cn.pdf' || item.name === 'doc.pdf'
  if (expectText) {
    check('文本层非空', state.text.length > 0, JSON.stringify(state.text.slice(0, 40)))
  } else {
    console.log(`  （非合成样本，不强制要求文本层：${state.text.length} 字符；扫描件本就无文字层）`)
  }
  if (item.name === 'cn.pdf') {
    check('中文短句可读', state.text.includes('电子书阅读器'), JSON.stringify(state.text.slice(0, 40)))
    check('中文标点可读', state.text.includes('《测试》'), JSON.stringify(state.text.slice(0, 60)))
  }

  // 只有 CMap 缺失才是「乱码」的直接原因；系统字体缺失会退回内置替代字体，属另一类
  const cmapWarnings = logs.filter((line) => /cMap|CMap/i.test(line))
  const fontWarnings = logs.filter((line) => /Cannot load system font/i.test(line))
  if (cmapWarnings.length) {
    console.log('  CMap 告警：')
    cmapWarnings.slice(0, 4).forEach((line) => console.log(`    ! ${line.slice(0, 150)}`))
  }
  if (fontWarnings.length) {
    console.log(`  （非内嵌字体告警 ${fontWarnings.length} 条，pdf.js 已用替代字体绘制，不影响可读性）`)
  }
  check('没有 CMap 加载失败', cmapWarnings.length === 0, `${cmapWarnings.length} 条`)

  await page.screenshot({ path: `${SHOTS}/19-host-pdf-${title}.png` })
  // 回书架（页面没开阅读器时不强求）
  await frame.locator('.topbar .left .icon-btn').first().click({ timeout: 4000 }).catch(() => undefined)
  await page.waitForTimeout(1200)
}

// 收尾
await browser.close()
rmSync(FIXTURE_DIR, { recursive: true, force: true })
console.log(failed === 0 ? '\nPASS host-pdf' : `\nFAILED ${failed}`)
process.exit(failed === 0 ? 0 : 1)
