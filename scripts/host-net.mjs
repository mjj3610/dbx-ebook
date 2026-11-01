/**
 * 真实宿主内的网络与资源管理器验证
 *
 * 断言：
 * 1. 页面里的 fetch 打不到外网（CSP connect-src 'none'），说明必须走后端
 * 2. net/request 能代发请求并拿到真实响应（这里用 api.openai.com 的无鉴权
 *    访问，401 就证明链路通了）
 * 3. storage/reveal 能拉起系统资源管理器
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const HOST = process.env.DBX_HOST ?? 'http://127.0.0.1:5193'

let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
await page.goto(HOST, { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
await page.getByRole('button', { name: '电子书阅读器' }).click()
await page.waitForTimeout(3500)
const frame = page.frames().find((f) => f !== page.mainFrame())
check('工作台 iframe 已创建', Boolean(frame))
if (!frame) {
  await browser.close()
  process.exit(1)
}

console.log('\n[1] 页面内直接 fetch 外网')
const direct = await frame.evaluate(async () => {
  try {
    const resp = await fetch('https://api.openai.com/v1/models')
    return `status ${resp.status}`
  } catch (err) {
    return `throw ${err.message}`
  }
})
console.log(`  fetch → ${direct}`)
check('页面内 fetch 被沙箱拦截（符合预期）', /throw/.test(direct), direct)

console.log('\n[2] 后端代发 net/request')
const proxied = await frame.evaluate(async () => {
  try {
    const res = await window.dbxPlugin.invoke('net/request', {
      url: 'https://www.example.com/',
      method: 'GET',
      headers: {},
      timeoutMs: 20000,
    })
    return { status: res.status, bytes: res.body ? res.body.length : 0, url: res.url }
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) }
  }
})
console.log(`  net/request → ${JSON.stringify(proxied)}`)
check('后端能连外网并取回响应体', proxied.status === 200 && proxied.bytes > 100, JSON.stringify(proxied))

console.log('\n[3] 后端拒绝非 http(s) 地址')
const blocked = await frame.evaluate(async () => {
  try {
    await window.dbxPlugin.invoke('net/request', { url: 'file:///C:/Windows/win.ini', method: 'GET' })
    return 'allowed'
  } catch (err) {
    return String(err && err.message ? err.message : err)
  }
})
console.log(`  file:// → ${blocked}`)
check('file:// 被拒绝', /http/.test(blocked), blocked)

console.log('\n[4] storage/reveal 拉起资源管理器')
const revealed = await frame.evaluate(async () => {
  try {
    const info = await window.dbxPlugin.invoke('storage/describe', {})
    const res = await window.dbxPlugin.invoke('storage/reveal', { path: info.root })
    return res
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) }
  }
})
console.log(`  reveal → ${JSON.stringify(revealed)}`)
check('资源管理器打开成功', revealed.ok === true, JSON.stringify(revealed))

await browser.close()
console.log(failed === 0 ? '\nPASS host-net' : `\nFAILED ${failed}`)
process.exit(failed === 0 ? 0 : 1)
