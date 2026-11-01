/**
 * 宿主内流程验证（需要先启动官方本地宿主）
 *
 * 前置：
 *   npm run build
 *   npx dbx-plugin dev --path . --port 5190
 * 运行：
 *   node scripts/host-flow.mjs
 *
 * 验证重点：宿主沙箱（origin === null）禁用了 IndexedDB 时，
 * 插件仍能完成「导入 → 书架 → 阅读 → 高亮 → 备份导出」全流程（内存库降级）。
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const HOST = process.env.DBX_HOST ?? 'http://127.0.0.1:5190'
const SHOTS = resolve('screenshots')

let failed = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

/** 测试用 TXT 正文（含章节标题，便于验证切章） */
const SAMPLE = [
  '第一章 山中来信',
  '',
  '清晨的风穿过窗棂，把桌上的信纸吹得簌簌作响。',
  '他伸手按住纸角，读到最后一行时，手指停住了。',
  '',
  // 长正文：只有超过一屏才测得到翻页与双页（早期样本只有 3 段，分页形同未测）
  ...Array.from({ length: 160 }, (_, index) =>
    index % 23 === 7
      ? `curl -Uri "https://mss-agi.openai.azure.com/openai/deployments/gpt-5.6-luna/chat/completions?api-version=2024-10-21?p=${index}" -Method Post`
      : `第 ${index + 3} 段：风从河谷里升起，掠过檐角，把摊开的书页翻到另一面；远处的山脊被阳光一层层点亮。`,
  ),
  '',
  '第二章 渡口',
  '',
  '渡口的船工说，今年的水比往年都要急。',
  '他望着对岸的灯火，忽然想起许多年前的那个黄昏。',
  // 随机后缀：书库按内容哈希去重，重复运行必须产生新书才能验证写入
  Date.now().toString(36),
].join('\n')

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('404')) errors.push(`console: ${message.text()}`)
})

await page.goto(HOST, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.getByRole('button', { name: '电子书阅读器' }).click()
await page.waitForTimeout(2500)

const frame = page.frames().find((f) => f !== page.mainFrame())
check('工作台 iframe 已创建', Boolean(frame))

const env = await frame.evaluate(() => {
  let idb = 'ok'
  try {
    indexedDB.open('probe')
  } catch (error) {
    idb = String(error)
  }
  return { origin: location.origin, idb, mounted: Boolean(document.querySelector('#app')?.children.length) }
})
console.log(`  环境：origin=${env.origin}，indexedDB=${env.idb.split(':')[0]}`)
check('插件已挂载', env.mounted)

// 有原生后端时不再降级：不该出现「仅本次会话」提示条
await page.waitForTimeout(500)
const warn = await frame.evaluate(() => document.querySelector('.storage-warn')?.innerText.replace(/\s+/g, ' ') ?? '')
const backendInfo = await frame.evaluate(() => window.dbxPlugin?.invoke?.('storage/describe').catch(() => null))
check('不再提示「仅本次会话」', warn === '', `实际: ${warn.slice(0, 40)}`)
check('原生后端提供了磁盘书库路径', typeof backendInfo?.root === 'string' && backendInfo.root.length > 3, JSON.stringify(backendInfo))

// 存储位置弹窗：沙箱内应如实说明目录选择被禁止
await frame.getByRole('button', { name: '存储位置' }).first().click()
await page.waitForTimeout(900)
const dialog = await frame.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, ' ')
  const mask = document.querySelector('.mask')
  return { open: Boolean(mask && getComputedStyle(mask).display !== 'none'), text }
})
check('存储位置弹窗可打开', dialog.open)
check('说明沙箱禁止选择本地文件夹', dialog.text.includes('沙箱'), `实际: ${dialog.text.slice(0, 80)}`)
await page.screenshot({ path: `${SHOTS}/15-host-storage-dialog.png` })
await frame.evaluate(() => document.querySelector('.mask')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
await page.waitForTimeout(400)

// 导入一本 TXT（沙箱内无法 fetch，直接构造 File）
const baseline = await frame.evaluate(() => document.querySelectorAll('.card').length)
await frame.evaluate((text) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([text], '山中来信.txt', { type: 'text/plain' }))
  document.querySelector('.app').dispatchEvent(
    new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
  )
}, SAMPLE)
await page.waitForTimeout(2500)

const shelf = await frame.evaluate(() => ({
  cards: document.querySelectorAll('.card').length,
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
}))
check('导入成功：书架书籍数增加', shelf.cards > baseline, `基线 ${baseline} → 实际 ${shelf.cards} 本`)

// 打开阅读
await frame.locator('.card').first().click()
await page.waitForTimeout(2500)
const reader = await frame.evaluate(() => {
  const host = document.querySelector('.page-host')
  const shadow = host?.shadowRoot
  // shadowRoot 的 textContent 前段是注入的 <style>，这里只取正文节点的文本
  const paragraphs = [...(shadow?.querySelectorAll('p, h1, h2, h3, div,p') ?? [])]
    .map((el) => el.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
  return {
    hasReader: Boolean(host),
    body: paragraphs.slice(0, 120),
    pageHostWidth: host ? Math.round(host.getBoundingClientRect().width) : 0,
  }
})
check('阅读器打开并渲染正文', reader.body.includes('清晨的风'), `实际: ${reader.body.slice(0, 60)}`)
check('正文栏宽受 820px 上限约束', reader.pageHostWidth > 0 && reader.pageHostWidth <= 820, `实际: ${reader.pageHostWidth}px`)

// 分页几何：纸面必须留在阅读区内，翻页后不能把整张纸甩出视口
const pageMetrics = () =>
  frame.evaluate(() => {
    const stage = document.querySelector('.stage')
    const frameEl = document.querySelector('.page-frame')
    const host = document.querySelector('.page-host')
    if (!stage || !frameEl || !host) return null
    const book = host.shadowRoot?.querySelector('.book')
    const sr = stage.getBoundingClientRect()
    const fr = frameEl.getBoundingClientRect()
    const hr = host.getBoundingClientRect()
    const mid = hr.left + hr.width / 2
    const visible = [...(book?.querySelectorAll('p') ?? [])].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.left >= hr.left - 1 && r.left < hr.right - 1 && r.top >= hr.top - 1 && r.top < hr.bottom
    })
    return {
      inStage: fr.x >= sr.x - 1 && fr.x + fr.width <= sr.x + sr.width + 1,
      frameW: Math.round(fr.width),
      columnWidth: parseFloat(book?.style.columnWidth ?? '0'),
      transform: book?.style.transform ?? '',
      visibleCount: visible.length,
      leftHalf: visible.filter((el) => el.getBoundingClientRect().left < mid).length,
      rightHalf: visible.filter((el) => el.getBoundingClientRect().left >= mid).length,
      labels: document.querySelector('.labels')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }
  })

const flowFirst = await pageMetrics()
check('纸面完整落在阅读区内', Boolean(flowFirst?.inStage))
check('首屏有可见正文', (flowFirst?.visibleCount ?? 0) > 0, `visible=${flowFirst?.visibleCount}`)

await frame.locator('.pager-next').click()
await page.waitForTimeout(700)
const flowSecond = await pageMetrics()
check('翻页后位移改变', flowSecond?.transform !== flowFirst?.transform, String(flowSecond?.transform))
check('翻页后纸面仍在阅读区内', Boolean(flowSecond?.inStage))
check('翻页后仍有可见正文（不是空白页）', (flowSecond?.visibleCount ?? 0) > 0, `visible=${flowSecond?.visibleCount}`)
check('进度百分比前进', flowSecond?.labels !== flowFirst?.labels, `${flowFirst?.labels} → ${flowSecond?.labels}`)
await page.screenshot({ path: `${SHOTS}/13-host-paged.png` })

// 双页：两列都要有正文
await frame.evaluate(() => {
  const buttons = [...document.querySelectorAll('.right .icon-btn')]
  buttons[3]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForTimeout(700)
await frame.evaluate(() => {
  const target = [...document.querySelectorAll('.segmented button')].find((b) => (b.textContent ?? '').includes('双页'))
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForTimeout(1500)
await page.keyboard.press('Escape')
await page.waitForTimeout(600)
const flowDouble = await pageMetrics()
check('双页两列都有正文', (flowDouble?.leftHalf ?? 0) > 0 && (flowDouble?.rightHalf ?? 0) > 0, `left=${flowDouble?.leftHalf} right=${flowDouble?.rightHalf}`)
check('双页纸面完整落在阅读区内', Boolean(flowDouble?.inStage))
await page.screenshot({ path: `${SHOTS}/13-host-double.png` })
await frame.evaluate(() => {
  const target = [...document.querySelectorAll('.segmented button')].find((b) => (b.textContent ?? '').includes('单页'))
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForTimeout(900)

await page.screenshot({ path: `${SHOTS}/13-host-degraded-reader.png` })

// 返回书架，确认书还在（同会话内）
await frame.locator('.topbar .left .icon-btn').first().click()
await page.waitForTimeout(1200)
const back = await frame.evaluate(() => document.querySelectorAll('.card').length)
check('返回书架后书籍仍在', back === shelf.cards, `实际 ${back} 本`)

// 备份导出可用（点击说明条上的备份入口）
await frame.getByRole('button', { name: '备份与同步' }).first().click()
await page.waitForTimeout(900)
const backupOpen = await frame.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, ' ')
  return /导出|备份|恢复/.test(text)
})
check('备份入口可打开（数据可导出留存）', backupOpen)

await page.screenshot({ path: `${SHOTS}/13-host-degraded-shelf.png` })
console.log('运行时错误:', errors.length ? errors.join(' | ') : 'none')
await browser.close()
console.log(failed === 0 ? '\n结果：全部通过' : `\n结果：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
