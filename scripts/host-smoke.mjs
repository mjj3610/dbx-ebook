/**
 * 宿主桥接冒烟测试
 * 目的：验证插件在 DBX 宿主沙箱中的契约是否成立
 *  1) window.dbxPlugin 存在时能等到 ready 并接管初始化
 *  2) 宿主 theme.appearance='dark' 时页面切到深色令牌
 *  3) 宿主 locale='zh-CN' 时界面为简体中文
 *  4) 宿主缺失（纯浏览器）时正常降级为浅色 + 默认语言
 * 运行：先 `npm run build`，再 `npx vite preview --port 4173`，最后 `node scripts/host-smoke.mjs`
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const BASE = process.env.E2E_BASE ?? 'http://localhost:4173'

let failed = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

/** 模拟宿主注入的 window.dbxPlugin */
function mockBridge(appearance, locale) {
  return `
    window.__hostCalls = []
    window.dbxPlugin = {
      ready: Promise.resolve({ pluginId: 'com.mjj3610.ebook' }),
      context: { pluginId: 'com.mjj3610.ebook' },
      locale: ${JSON.stringify(locale)},
      theme: { appearance: ${JSON.stringify(appearance)}, tokens: {} },
      request: async (method, params) => {
        window.__hostCalls.push({ method, params })
        return { ok: true }
      },
      copy: async (text) => {
        window.__hostCalls.push({ method: 'host.copy', text })
        return { ok: true }
      },
      onInit: (handler) => {
        window.__hostOnInit = handler
        return () => {}
      },
    }
  `
}

/** 取出实际绘制背景色的亮度：从深层元素向上找到第一个不透明背景 */
const luminance = `(() => {
  const parse = (color) => {
    const nums = color.match(/[\\d.]+/g)
    if (!nums) return null
    const [r, g, b, a = '1'] = nums.map(Number)
    if (a === 0) return null
    return 0.299 * r + 0.587 * g + 0.114 * b
  }
  let el = document.querySelector('#app .app, #app > *') ?? document.body
  while (el) {
    const value = parse(getComputedStyle(el).backgroundColor)
    if (value !== null) return value
    el = el.parentElement
  }
  return 255
})()`

const browser = await chromium.launch({ executablePath: CHROME, headless: true })

// ---------- 场景 1：宿主为深色 + 简体中文 ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  await page.addInitScript(mockBridge('dark', 'zh-CN'))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.app, .shelf, [class*="shelf"]', { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(600)

  console.log('[1] 宿主深色 + zh-CN')
  const appearance = await page.evaluate(() => document.documentElement.dataset.appearance)
  check('读取到宿主外观并写入 data-appearance', appearance === 'dark', `实际: ${appearance}`)

  const panel = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--c-panel').trim(),
  )
  check('深色令牌 --c-panel 生效', panel === '#1c1f26', `实际: ${panel}`)

  const luma = await page.evaluate(luminance)
  check('首屏背景为深色', luma < 90, `亮度: ${luma.toFixed(1)}`)

  const text = await page.evaluate(() => document.body.innerText.slice(0, 400))
  check('界面为简体中文', /书架|导入|设置|阅读/.test(text), `首屏文案: ${text.slice(0, 60)}`)

  const onInitSet = await page.evaluate(() => typeof window.__hostOnInit === 'function')
  check('已订阅宿主 onInit（跟随主题切换）', onInitSet)

  await page.close()
}

// ---------- 场景 2：宿主为浅色 + 英文 ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  await page.addInitScript(mockBridge('light', 'en-US'))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  console.log('[2] 宿主浅色 + en-US')
  const appearance = await page.evaluate(() => document.documentElement.dataset.appearance)
  check('浅色外观正确应用', appearance === 'light', `实际: ${appearance}`)

  const luma = await page.evaluate(luminance)
  check('首屏背景为浅色', luma > 180, `亮度: ${luma.toFixed(1)}`)

  const text = await page.evaluate(() => document.body.innerText.slice(0, 400))
  check('界面为英文', /Shelf|Import|Settings|Read/i.test(text), `首屏文案: ${text.slice(0, 60)}`)

  await page.close()
}

// ---------- 场景 3：无宿主（本地 npm run dev / 直接打开） ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  console.log('[3] 无宿主环境降级')
  const noBridge = await page.evaluate(() => typeof window.dbxPlugin === 'undefined')
  check('未注入桥接时不存在全局对象', noBridge)

  const mounted = await page.evaluate(() => Boolean(document.querySelector('#app')?.children.length))
  check('无宿主时仍能正常挂载渲染', mounted)

  const luma = await page.evaluate(luminance)
  check('默认浅色外观', luma > 180, `亮度: ${luma.toFixed(1)}`)

  await page.close()
}

await browser.close()
console.log(failed === 0 ? '\n结果：全部通过' : `\n结果：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
