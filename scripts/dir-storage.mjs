/**
 * 本地文件夹存储验证
 *
 * 思路：用 addInitScript 注入一个假的 showDirectoryPicker（底层用 localStorage 存文件），
 * 从而在无头浏览器里完整验证「选择文件夹 → 写入 library.json + books/ → 重新加载后恢复」。
 * 真实运行时用浏览器的 File System Access API，接口一致。
 *
 * 前置：npm run build && npx vite preview --port 4173
 * 运行：node scripts/dir-storage.mjs
 */
import { chromium } from 'playwright-core'
import { resolve } from 'node:path'

const CHROME = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1140/chrome-win/chrome.exe')
const BASE = process.env.E2E_BASE ?? 'http://localhost:4173'
const DIR_NAME = 'DBX测试目录'

let failed = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

const SAMPLE = ['第一章 渡口', '', '渡口的船工说，今年的水比往年都要急。', '他望着对岸的灯火。'].join('\n')

/** 注入假文件系统：localStorage 键 __fakefs__ 存 { 路径: 'txt:...' | 'b64:...' } */
const FAKE_FS = `
(() => {
  const KEY = '__fakefs__'
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {} } catch { return {} } }
  const save = (fs) => localStorage.setItem(KEY, JSON.stringify(fs))
  const b64 = (blob) => new Promise((done) => {
    const reader = new FileReader()
    reader.onload = () => done(String(reader.result).split(',')[1] || '')
    reader.onerror = () => done('')
    reader.readAsDataURL(blob)
  })
  const decode = (value) => {
    if (value.startsWith('txt:')) return value.slice(4)
    const bin = atob(value.slice(4))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    return bytes
  }
  const path = (prefix, name) => (prefix ? prefix + '/' + name : name)

  function fileHandle(prefix, name) {
    const full = path(prefix, name)
    return {
      kind: 'file',
      name,
      async getFile() {
        const fs = load()
        if (!(full in fs)) throw new DOMException('not found', 'NotFoundError')
        const value = fs[full]
        const content = decode(value)
        return new File([content], name)
      },
      async createWritable() {
        let pending = null
        return {
          async write(data) { pending = data },
          async close() {
            const fs = load()
            fs[full] = typeof pending === 'string' ? 'txt:' + pending : 'b64:' + (await b64(pending))
            save(fs)
          },
        }
      },
    }
  }

  function dirHandle(prefix, name) {
    return {
      kind: 'directory',
      name,
      async getFileHandle(file, options) {
        const full = path(prefix, file)
        const fs = load()
        if (!(full in fs)) {
          if (!options || !options.create) throw new DOMException('not found', 'NotFoundError')
          fs[full] = 'txt:'
          save(fs)
        }
        return fileHandle(prefix, file)
      },
      async getDirectoryHandle(dir, options) {
        if (!options || !options.create) {
          const fs = load()
          const head = path(prefix, dir) + '/'
          if (!Object.keys(fs).some((key) => key.startsWith(head))) {
            throw new DOMException('not found', 'NotFoundError')
          }
        }
        return dirHandle(path(prefix, dir), dir)
      },
      async removeEntry(entry) {
        const fs = load()
        const full = path(prefix, entry)
        let hit = false
        for (const key of Object.keys(fs)) {
          if (key === full || key.startsWith(full + '/')) { delete fs[key]; hit = true }
        }
        if (!hit) throw new DOMException('not found', 'NotFoundError')
        save(fs)
      },
      async queryPermission() { return 'granted' },
      async requestPermission() { return 'granted' },
    }
  }

  window.__fakeFs = () => load()
  window.showDirectoryPicker = async () => dirHandle('', ${JSON.stringify(DIR_NAME)})
})()
`

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('404')) errors.push(`console: ${message.text()}`)
})
await page.addInitScript(FAKE_FS)

/** 打开存储位置弹窗 */
async function openStorageDialog() {
  await page.getByRole('button', { name: '存储位置' }).first().click()
  await page.waitForSelector('.modes', { timeout: 5000 })
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)

// ---------- 1) 切换为本地文件夹 ----------
console.log('[1] 选择本地文件夹')
await openStorageDialog()
const beforeMode = await page.evaluate(() => document.querySelector('.current strong')?.textContent ?? '')
check('初始显示当前存储位置', beforeMode.length > 0, `实际: ${beforeMode}`)

await page.getByRole('button', { name: '选择文件夹' }).click()
await page.waitForTimeout(1500)
const afterMode = await page.evaluate(() => document.querySelector('.current strong')?.textContent ?? '')
check('切换后位置显示为所选文件夹', afterMode.includes(DIR_NAME), `实际: ${afterMode}`)
const badge = await page.evaluate(() => document.querySelector('.badge')?.textContent?.trim() ?? '')
check('标记为可跨会话', badge === '可跨会话', `实际: ${badge}`)
await page.screenshot({ path: 'screenshots/14-storage-dialog.png' })

await page.keyboard.press('Escape')
await page.evaluate(() => document.querySelector('.mask')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
await page.waitForTimeout(500)

// ---------- 2) 导入书籍，检查落盘 ----------
console.log('[2] 导入书籍并落盘')
await page.evaluate((text) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([text], '渡口.txt', { type: 'text/plain' }))
  document.querySelector('.app').dispatchEvent(
    new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
  )
}, SAMPLE)
await page.waitForTimeout(2500)

const disk = await page.evaluate(() => window.__fakeFs())
const keys = Object.keys(disk)
check('目录内生成 library.json', keys.includes('library.json'), `实际: ${keys.join(', ')}`)
check('书籍原文写入 books/', keys.some((key) => key.startsWith('books/')), `实际: ${keys.join(', ')}`)

const library = keys.includes('library.json') ? JSON.parse(disk['library.json'].replace(/^txt:/, '')) : null
check('library.json 记录 1 本书', library?.books?.length === 1, `实际: ${library?.books?.length}`)
check('library.json 记录书名', library?.books?.[0]?.title === '渡口', `实际: ${library?.books?.[0]?.title}`)
check(
  'library.json 记录文件索引',
  Array.isArray(library?.files) && library.files.length === 1,
  `实际: ${JSON.stringify(library?.files)}`,
)

// ---------- 3) 重新加载：数据仍在磁盘 ----------
console.log('[3] 重新加载后从磁盘恢复')
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(800)
const afterReloadCards = await page.evaluate(() => document.querySelectorAll('.card').length)

await openStorageDialog()
await page.getByRole('button', { name: '选择文件夹' }).click()
await page.waitForTimeout(1800)
await page.evaluate(() => document.querySelector('.mask')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
await page.waitForTimeout(800)
const restoredCards = await page.evaluate(() => document.querySelectorAll('.card').length)
check('重新选择同一目录后书籍恢复', restoredCards === 1, `重载后最初 ${afterReloadCards} 本 / 恢复后 ${restoredCards} 本`)

// ---------- 4) 能打开阅读 ----------
console.log('[4] 从目录读取并阅读')
await page.locator('.card').first().click()
await page.waitForTimeout(2200)
const reading = await page.evaluate(() => {
  const host = document.querySelector('.page-host')
  const shadow = host?.shadowRoot
  return [...(shadow?.querySelectorAll('p, h1, h2, h3') ?? [])].map((el) => el.textContent).join(' ')
})
check('正文从磁盘读取并渲染', reading.includes('渡口的船工'), `实际: ${reading.slice(0, 40)}`)
await page.screenshot({ path: 'screenshots/14-directory-storage.png' })

// ---------- 5) 删除书籍同时删除磁盘文件 ----------
console.log('[5] 删除书籍时同步清理磁盘文件')
await page.locator('.topbar .left .icon-btn').first().click()
await page.waitForTimeout(1000)
const filesBefore = await page.evaluate(() => Object.keys(window.__fakeFs()).filter((k) => k.startsWith('books/')).length)
await page.locator('.card').first().hover()
await page.locator('.del').first().click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: '删除' }).last().click()
await page.waitForTimeout(1500)
const filesAfter = await page.evaluate(() => Object.keys(window.__fakeFs()).filter((k) => k.startsWith('books/')).length)
check('磁盘上的书籍文件被删除', filesBefore === 1 && filesAfter === 0, `删除前 ${filesBefore} / 删除后 ${filesAfter}`)

const finalLibrary = await page.evaluate(() => {
  const raw = window.__fakeFs()['library.json']
  return raw ? JSON.parse(raw.replace(/^txt:/, '')) : null
})
check('library.json 同步为空库', Array.isArray(finalLibrary?.books) && finalLibrary.books.length === 0)

console.log('运行时错误:', errors.length ? errors.join(' | ') : 'none')
await browser.close()
console.log(failed === 0 ? '\n结果：全部通过' : `\n结果：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
