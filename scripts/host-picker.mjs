/**
 * 真实宿主内的「选择文件夹」验证
 *
 * 沙箱里 showDirectoryPicker 会被 Chrome 直接拒绝，所以目录选择必须由
 * 原生后端（storage/listDirs）读盘、插件自绘目录树。本脚本在真实宿主里
 * 完整走一遍：打开存储设置 → 浏览 → 走快捷位置 → 新建文件夹 →
 * 选中 → 书库真的切过去（磁盘上有 library.json）。
 *
 * 前置：npm run build && npx dbx-plugin dev --path . --port 5191
 * 运行：node scripts/host-picker.mjs
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'

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

/** 待创建的测试目录名（带时间戳，避免与上次残留冲突） */
const FOLDER = `picker-${Date.now().toString(36)}`

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

console.log('\n[1] 打开存储设置')
await frame.locator('.btn-storage').click()
await page.waitForTimeout(900)
const dialogOpen = await frame.locator('#storage-root').isVisible()
check('存储对话框已打开', dialogOpen)

console.log('\n[2] 浏览目录')
await frame.getByRole('button', { name: '浏览…' }).click()
await page.waitForTimeout(1200)
const picker = frame.locator('.picker')
check('目录选择器已出现', await picker.isVisible())
const driveCount = await frame.locator('.side .side-item').count()
check('左侧列出了磁盘/快捷位置', driveCount > 0, `${driveCount} 项`)

console.log('\n[3] 走快捷位置到插件数据目录')
// 先到用户目录，这里有子文件夹，截一张有内容的界面图
await frame.locator('.side .side-item').filter({ hasText: '用户目录' }).first().click()
await page.waitForTimeout(1500)
const homeEntries = await frame.locator('.list .entry').count()
console.log(`  用户目录子文件夹：${homeEntries} 个`)
check('目录内容能列出来', homeEntries > 0, `${homeEntries} 个`)
await page.screenshot({ path: `${SHOTS}/20-host-dir-picker.png` })

const shortcut = frame.locator('.side .side-item').filter({ hasText: '插件数据' }).first()
const hasShortcut = (await shortcut.count()) > 0
check('有「插件数据」快捷位置', hasShortcut)
if (hasShortcut) {
  await shortcut.click()
  await page.waitForTimeout(1500)
}
const dataPath = (await frame.locator('.crumb').textContent())?.trim() ?? ''
console.log(`  当前目录：${dataPath}`)
check('已进入数据目录', dataPath.length > 3, dataPath)
check('该目录可写', !(await frame.locator('.foot .warn').isVisible()))

console.log('\n[4] 新建文件夹')
await frame.getByRole('button', { name: '新建文件夹' }).click()
await page.waitForTimeout(400)
await frame.locator('.create-input').fill(FOLDER)
await frame.getByRole('button', { name: '创建', exact: true }).click()
await page.waitForTimeout(1500)
const createdPath = (await frame.locator('.crumb').textContent())?.trim() ?? ''
console.log(`  新建后进入：${createdPath}`)
check('自动进入新建的文件夹', createdPath.endsWith(FOLDER), createdPath)
check('磁盘上真的建出来了', existsSync(createdPath), createdPath)

console.log('\n[5] 非法文件夹名被拒绝')
await frame.getByRole('button', { name: '新建文件夹' }).click()
await page.waitForTimeout(300)
await frame.locator('.create-input').fill('bad/name')
await frame.getByRole('button', { name: '创建', exact: true }).click()
await page.waitForTimeout(1200)
const blocked = await frame.locator('.list .empty.error').isVisible().catch(() => false)
check('带路径分隔符的名称被拒绝', blocked)
await frame.getByRole('button', { name: '新建文件夹' }).click()
await page.waitForTimeout(300)

console.log('\n[6] 选中该文件夹，书库切过去')
await frame.getByRole('button', { name: '选择此文件夹' }).click()
await page.waitForTimeout(3500)
const rootValue = await frame.locator('#storage-root').inputValue()
console.log(`  路径输入框：${rootValue}`)
check('路径已回填为所选目录', rootValue === createdPath, rootValue)
check('切换后磁盘上有 library.json', existsSync(resolve(createdPath, 'library.json')))
check('切换后磁盘上有 books 目录', existsSync(resolve(createdPath, 'books')))
const status = (await frame.locator('.status').textContent().catch(() => '')) ?? ''
check('界面提示书库位置已更新', status.includes('书库位置已更新'), status.slice(0, 40))
await page.screenshot({ path: `${SHOTS}/20-host-picker-applied.png` })

console.log('\n[7] 恢复默认位置并清理')
await frame.getByRole('button', { name: '恢复默认' }).click()
await page.waitForTimeout(3000)
const afterReset = await frame.locator('#storage-root').inputValue()
check('已恢复默认书库路径', !afterReset.endsWith(FOLDER), afterReset)
// 清理是尽力而为：工作区里的 safe-delete 垫片偶尔会超时，不该因此让整轮回归判失败
try {
  if (existsSync(createdPath)) rmSync(createdPath, { recursive: true, force: true, maxRetries: 3 })
} catch (err) {
  console.log(`  （清理跳过：${err.message.split('\n')[0]}）`)
}
check('测试目录已清理', !existsSync(createdPath))

await frame.getByRole('button', { name: '关闭' }).first().click().catch(() => undefined)
await browser.close()

const errors = logs.filter((line) => /pageerror|SecurityError/i.test(line))
if (errors.length) {
  console.log('\n控制台异常：')
  errors.slice(0, 5).forEach((line) => console.log(`  ! ${line.slice(0, 160)}`))
}
check('无沙箱/脚本异常', errors.length === 0, `${errors.length} 条`)

console.log(failed === 0 ? '\nPASS host-picker' : `\nFAILED ${failed}`)
process.exit(failed === 0 ? 0 : 1)
