/**
 * 中文 PDF 文本提取校验（Node 环境，无需浏览器）
 *
 * 目的：验证 fixtures/cn.pdf（Type0 + /UniGB-UCS2-H + Adobe-GB1）里
 * 的中文能被正确还原成 Unicode，而不是乱码。
 *
 * 对比两组：
 *   A. 带内联 CMap 工厂（插件里的真实做法）→ 应得到准确中文
 *   B. 空 CMap（模拟沙箱内取不到 .bcmap）→ 应得不到正确中文（复现乱码）
 *
 * 用法：node scripts/pdf-cmap-check.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

const EXPECT = ['电子书阅读器', '中文乱码验证：简体中文排版', '标点，句号。书名号《测试》与数字 2026']

/** 从生成的 TS 模块里取出两张 base64 表（去掉类型注解后求值） */
function loadInlineData() {
  const src = readFileSync(join(root, 'src/assets/pdfjs/pdfjs-data.generated.ts'), 'utf8')
  const code = src
    .replace(/export const (\w+): Record<string, string> =/g, 'const $1 =')
    .replace(/^\/\*[\s\S]*?\*\//, '')
  return new Function(`${code}; return { CMAP_BASE64, STANDARD_FONT_BASE64 }`)()
}

const { CMAP_BASE64, STANDARD_FONT_BASE64 } = loadInlineData()

const cache = new Map()
function bytes(map, key) {
  if (cache.has(key)) return cache.get(key)
  const b64 = map[key]
  if (!b64) return null
  const out = new Uint8Array(Buffer.from(b64, 'base64'))
  cache.set(key, out)
  return out
}

class InlineCMapReaderFactory {
  constructor({ isCompressed = true } = {}) {
    this.isCompressed = isCompressed
  }
  async fetch({ name }) {
    const data = bytes(CMAP_BASE64, name)
    if (!data) throw new Error(`missing cMap ${name}`)
    return { cMapData: data.slice(), isCompressed: this.isCompressed }
  }
}

class EmptyCMapReaderFactory {
  constructor({ isCompressed = true } = {}) {
    this.isCompressed = isCompressed
  }
  async fetch({ name }) {
    throw new Error(`no cMap ${name}`)
  }
}

class InlineStandardFontDataFactory {
  constructor() {}
  async fetch({ filename }) {
    const data = bytes(STANDARD_FONT_BASE64, filename)
    if (!data) throw new Error(`missing font ${filename}`)
    return data.slice()
  }
}

async function extractText(options) {
  const data = new Uint8Array(readFileSync(join(root, 'fixtures/cn.pdf')))
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, ...options }).promise
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  const text = content.items.map((i) => i.str).join('')
  await doc.destroy()
  return text
}

let failed = 0
const check = (ok, label, extra = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failed += 1
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

console.log('pdf-cmap-check')
console.log('  内联 CMap 表:', Object.keys(CMAP_BASE64).length, '条；标准字体:', Object.keys(STANDARD_FONT_BASE64).length, '条')

// A. 带内联工厂
let good = ''
try {
  good = await extractText({
    cMapUrl: 'inline:',
    cMapPacked: true,
    standardFontDataUrl: 'inline:',
    CMapReaderFactory: InlineCMapReaderFactory,
    StandardFontDataFactory: InlineStandardFontDataFactory,
  })
  check(EXPECT.every((line) => good.includes(line)), '内联 CMap 能还原中文', JSON.stringify(good))
} catch (err) {
  failed += 1
  console.log('  FAIL 内联 CMap 提取抛错 —', err.message)
}

check(Object.keys(CMAP_BASE64).includes('UniGB-UCS2-H'), '内置 UniGB-UCS2-H')
check(Object.keys(CMAP_BASE64).includes('Adobe-GB1-UCS2'), '内置 Adobe-GB1-UCS2')
check(Object.keys(CMAP_BASE64).includes('GBK-EUC-H'), '内置 GBK-EUC-H')

// B. 空 CMap（对照组，验证样本确实能复现乱码）
let bad = ''
try {
  bad = await extractText({
    cMapUrl: 'inline:',
    cMapPacked: true,
    CMapReaderFactory: EmptyCMapReaderFactory,
  })
} catch {
  bad = ''
}
check(!EXPECT.every((line) => bad.includes(line)), '缺少 CMap 时中文确实丢失（对照组有效）')

console.log(failed === 0 ? 'PASS pdf-cmap-check' : `FAILED ${failed}`)
process.exit(failed === 0 ? 0 : 1)
