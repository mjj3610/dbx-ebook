/**
 * 截图与图标生成
 * 1) 生成插件图标 icon.png（由 assets/plugin.svg 渲染）
 * 2) 抓取书架与各阅读模式的界面截图，便于视觉自检
 * 运行：先 `npm run build`，再 `npx vite preview --port 4173`，最后 `node scripts/screenshots.mjs`
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'
import { cpSync, rmSync, existsSync, mkdirSync } from 'node:fs'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const BASE = process.env.E2E_BASE ?? 'http://localhost:4173'
const DIR = resolve('ui/fixtures')
const SHOTS = resolve('screenshots')
mkdirSync(SHOTS, { recursive: true })
if (existsSync(DIR)) rmSync(DIR, { recursive: true })
cpSync('fixtures', DIR, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
await page.goto(BASE, { waitUntil: 'networkidle' })

// 图标：把 SVG 渲染成 256×256 PNG
await page.setContent(
  `<html><body style="margin:0;background:transparent">${(
    await import('node:fs')
  ).readFileSync('assets/plugin.svg', 'utf-8')}</body></html>`,
)
await page.setViewportSize({ width: 256, height: 256 })
await page.locator('svg').screenshot({ path: 'icon.png', omitBackground: true })
console.log('icon.png 生成完成')

// 界面截图
await page.setViewportSize({ width: 1280, height: 860 })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.screenshot({ path: `${SHOTS}/01-empty-shelf.png` })

await page.evaluate(async () => {
  const names = ['novel.txt', 'book.epub', 'comic.cbz', 'doc.pdf']
  const transfer = new DataTransfer()
  for (const name of names) {
    const response = await fetch(`/fixtures/${name}`)
    transfer.items.add(new File([await response.blob()], name))
  }
  document.querySelector('.app').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
})
await page.waitForSelector('.card')
await page.waitForTimeout(1200)
await page.screenshot({ path: `${SHOTS}/02-shelf.png` })

await page.locator('.card', { hasText: 'novel' }).first().click()
await page.waitForTimeout(1400)
await page.screenshot({ path: `${SHOTS}/03-reader-paged.png` })

await page.locator('.right .icon-btn').nth(3).click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${SHOTS}/04-settings.png` })
await page.locator('.segmented button', { hasText: '双页' }).click()
await page.waitForTimeout(800)
await page.screenshot({ path: `${SHOTS}/05-reader-double.png` })
await page.locator('.panel .icon-btn').last().click()
await page.waitForTimeout(300)

await page.locator('.right .icon-btn').first().click()
await page.waitForTimeout(500)
await page.screenshot({ path: `${SHOTS}/06-toc.png` })
await page.locator('.panel .icon-btn').last().click()
await page.waitForTimeout(300)

await page.locator('.topbar .left .icon-btn').click()
await page.waitForTimeout(800)
await page.locator('.card', { hasText: 'comic' }).first().click()
await page.waitForTimeout(1200)
await page.screenshot({ path: `${SHOTS}/07-comic.png` })

await page.locator('.topbar .left .icon-btn').click()
await page.waitForTimeout(800)
await page.locator('.card', { hasText: 'doc' }).first().click()
await page.waitForTimeout(2800)
await page.screenshot({ path: `${SHOTS}/08-pdf.png` })

await page.locator('.topbar .left .icon-btn').click()
await page.waitForTimeout(700)
await page.locator('.tools .btn-ghost').first().click()
await page.waitForTimeout(600)
await page.screenshot({ path: `${SHOTS}/09-backup.png` })

// 宿主深色外观：注入模拟桥接，验证跟随宿主主题
const darkPage = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
await darkPage.addInitScript(`
  window.dbxPlugin = {
    ready: Promise.resolve({}),
    context: {},
    locale: 'zh-CN',
    theme: { appearance: 'dark', tokens: {} },
    request: async () => ({}),
    copy: async () => ({}),
    onInit: () => () => {},
  }
`)
await darkPage.goto(BASE, { waitUntil: 'networkidle' })
await darkPage.evaluate(async () => {
  const names = ['novel.txt', 'book.epub', 'comic.cbz', 'doc.pdf']
  const transfer = new DataTransfer()
  for (const name of names) {
    const response = await fetch(`/fixtures/${name}`)
    transfer.items.add(new File([await response.blob()], name))
  }
  document.querySelector('.app').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
})
await darkPage.waitForSelector('.card')
await darkPage.waitForTimeout(1200)
await darkPage.screenshot({ path: `${SHOTS}/10-shelf-dark.png` })
await darkPage.locator('.card', { hasText: 'novel' }).first().click()
await darkPage.waitForTimeout(1400)
await darkPage.screenshot({ path: `${SHOTS}/11-reader-dark.png` })
await darkPage.close()

await browser.close()
rmSync(DIR, { recursive: true, force: true })
console.log('截图完成：', SHOTS)
