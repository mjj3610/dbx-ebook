/**
 * 真实宿主沙箱内的「选中 → 高亮 / 批注」诊断
 *
 * 为什么必须在宿主里跑：
 *   - 宿主 CSP 是 `connect-src 'none'` + `sandbox="allow-scripts"`（origin=null），
 *     注入的 <style> 能不能生效取决于 style-src 是否放行 inline，
 *     浏览器预览（vite preview）没有这条限制，测不出来。
 *   - 用户报的「无法添加笔记」是选区拿不到文本，属于宿主与预览都走同一套代码，
 *     但只有真拖选（而非程序化 setRange）才能复现真实抬手事件序列。
 *
 * 本脚本用**真实鼠标拖拽**选中 PDF 文本层，再走「浮条 → 批注 → 保存 → 笔记面板 → 重开」全链路。
 *
 * 前置：npm run build && npx dbx-plugin dev --path . --port 5191
 * 运行：node scripts/host-note.mjs
 * 可选：PDF_FILES=cn.pdf,multi.pdf 指定样本
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'
import { readFileSync, mkdirSync } from 'node:fs'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const HOST = process.env.DBX_HOST ?? 'http://127.0.0.1:5191'
const SHOTS = resolve('screenshots')
mkdirSync(SHOTS, { recursive: true })

let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

/** 每轮追加唯一尾部注释，避开「内容哈希相同 → 导入即跳过」 */
const TAIL_TAG = `\n% dbx-note-test-${Date.now().toString(36)}\n`
const PDFS = (process.env.PDF_FILES ?? 'cn.pdf,multi.pdf')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)
  .map((name) => ({
    name,
    base64: Buffer.concat([readFileSync(resolve('fixtures', name)), Buffer.from(TAIL_TAG, 'latin1')]).toString(
      'base64',
    ),
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
  process.exit(1)
}
const env = await frame.evaluate(() => ({ origin: location.origin }))
console.log(`  环境：origin=${env.origin}`)

/** 沙箱内不能 fetch，用字节直接构造 File 走拖拽导入 */
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

/** 等书架出现这本书（大文件慢，给足时间） */
async function waitForCard(title, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await frame.evaluate(
      (wanted) => [...document.querySelectorAll('.card')].some((card) => (card.textContent ?? '').includes(wanted)),
      title,
    )
    if (found) return true
    await page.waitForTimeout(400)
  }
  return false
}

async function openBook(title) {
  await frame.evaluate((wanted) => {
    const target = [...document.querySelectorAll('.card')].find((card) => (card.textContent ?? '').includes(wanted))
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, title)
  await page.waitForTimeout(4500)
}

async function backToShelf() {
  await frame.locator('.topbar .left .icon-btn').first().click({ timeout: 5000 }).catch(() => undefined)
  await page.waitForTimeout(1200)
}

/**
 * 真实鼠标拖选：从文本层第一个可见 span 的左端拖到第三个 span 的右端。
 * 不用 programmatic setRange —— 用户报的问题恰恰出在真实拖选的抬手序列上。
 */
async function dragSelect() {
  // 注意：page.mouse 用的是**主页面**坐标系，而 frame.evaluate 里的 getBoundingClientRect
  // 给的是 iframe 内坐标。之前混用这两套坐标，拖拽点整体偏移到宿主外壳上，
  // 于是「拖选」出的其实是宿主 UI 的文字，测试假阴性就是这么来的。
  // locator.boundingBox() 已经换算成主页面坐标，直接可用。
  const spans = frame.locator('.text-layer').first().locator('span')
  const total = await spans.count()
  const boxes = []
  for (let index = 0; index < total && boxes.length < 3; index += 1) {
    const box = await spans.nth(index).boundingBox()
    if (!box || box.width < 8 || box.height < 4) continue
    const text = (await spans.nth(index).textContent())?.trim() ?? ''
    if (!text) continue
    boxes.push(box)
  }
  if (!boxes.length) return { selected: '', boxes: 0 }

  const first = boxes[0]
  const last = boxes[boxes.length - 1]
  const startX = first.x + 2
  const startY = first.y + first.height / 2
  // 只有一个 span（整页挤一行）时就在这个 span 内部拖，不强求跨段
  const endX = boxes.length > 1 ? last.x + last.width - 2 : first.x + Math.max(12, first.width * 0.6)
  const endY = boxes.length > 1 ? last.y + last.height / 2 : startY

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 8 })
  await page.mouse.move(endX, endY, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(700)

  const selected = await frame.evaluate(() => (window.getSelection()?.toString() ?? '').trim())
  return { selected, boxes: boxes.length }
}

for (const item of PDFS) {
  const title = item.name.replace(/\.pdf$/i, '')
  console.log(`\n[${item.name}] 导入并打开`)
  logs.length = 0
  await importPdf(item)

  const onShelf = await waitForCard(title)
  check('书架上有这本 PDF', onShelf, title)
  if (!onShelf) continue

  await openBook(title)

  // 1) 高亮样式表是否注入成功（宿主 style-src 必须放行 inline）
  const styleInjected = await frame.evaluate(() => {
    const el = document.querySelector('style[data-dbx-mark="pdf"]')
    return Boolean(el && (el.textContent ?? '').includes('mark[data-color'))
  })
  check('宿主里注入了高亮样式表', styleInjected)

  const drag = await dragSelect()
  check('真实拖选取到文字', drag.selected.length > 0, `boxes=${drag.boxes} text=${JSON.stringify(drag.selected.slice(0, 20))}`)

  const barVisible = await frame.locator('.bar').isVisible().catch(() => false)
  check('拖选后浮条出现', barVisible)

  if (!barVisible) {
    await page.screenshot({ path: `${SHOTS}/21-host-note-nobar-${title}.png` })
    continue
  }

  // 2) 批注按钮 → 弹窗 → 写字 → 保存
  await frame.locator('.bar .act').first().click()
  await page.waitForTimeout(600)
  const dialogOpen = await frame.locator('.note-dialog').isVisible().catch(() => false)
  check('批注弹窗打开', dialogOpen)

  const comment = `宿主批注-${Date.now().toString(36)}`
  if (dialogOpen) {
    await frame.locator('.note-dialog textarea').fill(comment)
    await frame.locator('.note-dialog .btn-primary').click()
    await page.waitForTimeout(900)
  }

  const afterSave = await frame.evaluate(() => {
    const mark = document.querySelector('.text-layer mark[data-note-id]')
    if (!mark) return null
    const style = getComputedStyle(mark)
    return {
      color: style.color,
      background: style.backgroundColor,
      text: (mark.textContent ?? '').trim(),
    }
  })
  check('批注保存后高亮写入文本层', Boolean(afterSave), JSON.stringify(afterSave))
  // 文本层文字是透明的（真字在 canvas 上），背景必须由样式给，否则等于没高亮
  check(
    '高亮背景可见且文字保持透明',
    Boolean(afterSave) &&
      afterSave.background !== 'rgba(0, 0, 0, 0)' &&
      afterSave.background !== 'transparent' &&
      /rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(afterSave.color),
    JSON.stringify(afterSave),
  )

  // 3) 笔记面板：引文 + 批注正文都要在
  await frame.locator('.right .icon-btn').nth(1).click()
  await page.waitForTimeout(800)
  const panel = await frame.evaluate(() => {
    const notes = [...document.querySelectorAll('.note')]
    return {
      count: notes.length,
      quotes: notes.map((note) => (note.querySelector('.quote')?.textContent ?? '').trim()),
      comments: notes.map((note) => (note.querySelector('.comment')?.textContent ?? '').trim()),
    }
  })
  check('笔记面板里有这条批注', panel.count > 0, `count=${panel.count}`)
  check(
    '批注正文写进了笔记',
    panel.comments.some((text) => text.includes(comment)),
    JSON.stringify(panel.comments),
  )
  await page.screenshot({ path: `${SHOTS}/20-host-note-${title}.png` })

  // 4) 关面板 → 回书架 → 重开：高亮与批注都要还在
  await frame.locator('.panel .icon-btn').last().click()
  await page.waitForTimeout(400)
  await backToShelf()
  await openBook(title)

  const reopened = await frame.evaluate(() => ({
    marks: document.querySelectorAll('.text-layer mark[data-note-id]').length,
  }))
  check('重开后高亮仍在', reopened.marks > 0, `marks=${reopened.marks}`)

  await frame.locator('.right .icon-btn').nth(1).click()
  await page.waitForTimeout(700)
  const commentsAgain = await frame.evaluate(() =>
    [...document.querySelectorAll('.note .comment')].map((node) => (node.textContent ?? '').trim()),
  )
  check('重开后批注正文仍在', commentsAgain.some((text) => text.includes(comment)), JSON.stringify(commentsAgain))

  // 5) 清场：删掉本轮笔记，保证下一轮书架干净
  await frame.locator('.panel .note .del').first().click().catch(() => undefined)
  await page.waitForTimeout(500)
  await frame.locator('.dialog .btn-danger, .dialog .btn-primary').last().click().catch(() => undefined)
  await page.waitForTimeout(500)
  await frame.locator('.panel .icon-btn').last().click().catch(() => undefined)
  await page.waitForTimeout(300)
  await backToShelf()

  const errors = logs.filter((line) => line.startsWith('pageerror:'))
  check('没有运行时异常', errors.length === 0, errors.slice(0, 2).join(' | '))
}

/**
 * 文字流（EPUB / TXT）：正文在 Shadow DOM 里
 *
 * Chrome 下 `window.getSelection()` 只给到**折叠到宿主元素**的空范围（矩形宽度 0），
 * 真实选区只有 `ShadowRoot.getSelection()` 才拿得到 —— 这条路径必须单独回归，
 * 否则「PDF 修好了、EPUB 还是选不出浮条」这种半修状态不会被发现。
 */
async function importFlow(fixture, mime, title) {
  console.log(`\n[${fixture}] 导入并打开`)
  logs.length = 0
  const bytes = [
    ...Buffer.concat([readFileSync(resolve('fixtures', fixture)), Buffer.from(`\n% flow-${Date.now()}\n`, 'latin1')]),
  ]
  const name = `flow-${Date.now()}-${fixture}`
  await frame.evaluate(
    ({ bytes, name, mime }) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: mime }))
      document.querySelector('.app').dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      )
    },
    { bytes, name, mime },
  )
  await page.waitForTimeout(4500)

  const onShelf = await frame.evaluate(
    (wanted) => [...document.querySelectorAll('.card')].some((c) => (c.textContent ?? '').includes(wanted)),
    title,
  )
  check('书架上有这本文字书', onShelf, title)
  if (!onShelf) return false

  await openBook(title)
  return true
}

if (await importFlow('book.epub', 'application/epub+zip', '测试之书')) {
  // locator 会穿透 open shadow root，boundingBox 已是主页面坐标
  const para = frame.locator('.book p, .book li, .book div').filter({ hasText: /[\s\S]/ }).first()
  const box = await para.boundingBox({ timeout: 8000 }).catch(() => null)
  check('EPUB 找到可拖选段落', Boolean(box), JSON.stringify(box))

  if (box) {
    await page.mouse.move(box.x + 6, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 8 })
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(800)

    const shadowSel = await frame.evaluate(() => {
      const root = document.querySelector('.page-host')?.shadowRoot
      const selection = root && typeof root.getSelection === 'function' ? root.getSelection() : null
      return {
        text: (selection?.toString() ?? '').trim().slice(0, 24),
        windowText: (window.getSelection()?.toString() ?? '').trim().slice(0, 24),
      }
    })
    check('Shadow DOM 选区能取到文字', shadowSel.text.length > 0, JSON.stringify(shadowSel))

    const flowBar = await frame.locator('.bar').isVisible().catch(() => false)
    check('EPUB 选中后浮条出现', flowBar)

    if (flowBar) {
      await frame.locator('.bar .act').first().click()
      await page.waitForTimeout(700)
      const comment = `EPUB批注-${Date.now().toString(36)}`
      await frame.locator('.note-dialog textarea').fill(comment)
      await frame.locator('.note-dialog .btn-primary').click()
      await page.waitForTimeout(1000)

      const flowMark = await frame.evaluate(() => {
        const root = document.querySelector('.page-host')?.shadowRoot
        const mark = root?.querySelector('.book mark[data-note-id]')
        if (!mark) return null
        const style = getComputedStyle(mark)
        return { background: style.backgroundColor, color: style.color, text: (mark.textContent ?? '').slice(0, 20) }
      })
      check('EPUB 高亮写入正文', Boolean(flowMark), JSON.stringify(flowMark))
      check(
        'EPUB 高亮背景可见且文字不透明',
        Boolean(flowMark) &&
          flowMark.background !== 'rgba(0, 0, 0, 0)' &&
          !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/.test(flowMark.color),
        JSON.stringify(flowMark),
      )

      await frame.locator('.right .icon-btn').nth(1).click()
      await page.waitForTimeout(800)
      const comments = await frame.evaluate(() =>
        [...document.querySelectorAll('.note .comment')].map((node) => (node.textContent ?? '').trim()),
      )
      check('EPUB 批注进入笔记面板', comments.some((text) => text.includes(comment)), JSON.stringify(comments))
      await page.screenshot({ path: `${SHOTS}/20-host-note-epub.png` })

      await frame.locator('.panel .icon-btn').last().click()
      await page.waitForTimeout(400)
      await backToShelf()
      await openBook('测试之书')
      const again = await frame.evaluate(
        () => document.querySelector('.page-host')?.shadowRoot?.querySelectorAll('.book mark[data-note-id]').length ?? 0,
      )
      check('重开 EPUB 后高亮仍在', again > 0, `mark=${again}`)

      await frame.locator('.right .icon-btn').nth(1).click()
      await page.waitForTimeout(600)
      await frame.locator('.panel .note .del').first().click().catch(() => undefined)
      await page.waitForTimeout(500)
      await frame.locator('.dialog .btn-danger, .dialog .btn-primary').last().click().catch(() => undefined)
      await page.waitForTimeout(400)
      await frame.locator('.panel .icon-btn').last().click().catch(() => undefined)
      await page.waitForTimeout(300)
      await backToShelf()
    }

    const flowErrors = logs.filter((line) => line.startsWith('pageerror:'))
    check('EPUB 没有运行时异常', flowErrors.length === 0, flowErrors.slice(0, 2).join(' | '))
  }
}

await browser.close()
console.log(failed === 0 ? '\nPASS host-note' : `\nFAILED ${failed}`)
process.exit(failed === 0 ? 0 : 1)
