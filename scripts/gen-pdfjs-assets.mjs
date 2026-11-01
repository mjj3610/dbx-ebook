/**
 * 生成 src/assets/pdfjs/pdfjs-data.generated.ts
 *
 * 目的：DBX 宿主把插件页面放进 sandbox iframe，CSP 为
 *   default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:;
 *   img-src data: blob:; connect-src 'none'
 * 因此 pdf.js 无法通过 fetch(cMapUrl) 拉取 CMap / 标准字体数据，
 * 缺 CMap 时中文（Adobe-GB1 / GBK-EUC / UniGB-UCS2 等 CID 字体）会整页乱码。
 *
 * 方案：把 .bcmap 与标准字体文件以 base64 内联进 bundle，
 * 用自定义 CMapReaderFactory / StandardFontDataFactory 从内存返回字节，
 * 全程不产生任何网络请求（连 blob: 都不需要）。
 *
 * 用法：node scripts/gen-pdfjs-assets.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cmapDir = join(root, 'node_modules/pdfjs-dist/cmaps')
const fontDir = join(root, 'node_modules/pdfjs-dist/standard_fonts')
const outFile = join(root, 'src/assets/pdfjs/pdfjs-data.generated.ts')

function readDirFiles(dir, filter) {
  return readdirSync(dir)
    .filter((f) => filter(f) && statSync(join(dir, f)).isFile())
    .sort()
}

/**
 * CMap：全部收录（约 1.1MB）。
 * PDF 里的 /Encoding 名称五花八门（UniGB-UCS2-H、GBK-EUC-H、B5pc-H、Adobe-GB1-UCS2…），
 * 少一个就会让对应文字整段乱码，宁可多带不可漏。
 */
const cmapFiles = readDirFiles(cmapDir, (f) => f.endsWith('.bcmap'))

/**
 * 标准字体：只带 Foxit 的 .pfb（约 190KB），覆盖 Symbol / ZapfDingbats / Courier / Times。
 * 四个 LiberationSans-*.ttf 共 573KB，仅为 Helvetica 等无内嵌字体的西文提供精确字宽，
 * 缺失时 pdf.js 会回退到系统 sans-serif，观感无明显差异，故不入包以控制体积。
 */
const fontFiles = readDirFiles(fontDir, (f) => f.endsWith('.pfb'))

const toB64 = (p) => readFileSync(p).toString('base64')

let bytes = 0
const cmapEntries = cmapFiles.map((f) => {
  const buf = readFileSync(join(cmapDir, f))
  bytes += buf.length
  return `  ${JSON.stringify(f.replace(/\.bcmap$/, ''))}: ${JSON.stringify(buf.toString('base64'))},`
})
const fontEntries = fontFiles.map((f) => {
  const buf = readFileSync(join(fontDir, f))
  bytes += buf.length
  return `  ${JSON.stringify(f)}: ${JSON.stringify(buf.toString('base64'))},`
})

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(
  outFile,
  `/* 自动生成，请勿手工编辑 —— 运行 node scripts/gen-pdfjs-assets.mjs 重新生成
 * 来源：pdfjs-dist/cmaps（全集）+ pdfjs-dist/standard_fonts（Foxit .pfb）
 * 数据总量：${(bytes / 1024).toFixed(0)} KB（base64 内联，沙箱内零网络请求）
 */

/** bcmap 名称（不含扩展名） → base64 字节 */
export const CMAP_BASE64: Record<string, string> = {
${cmapEntries.join('\n')}
}

/** 标准字体文件名 → base64 字节 */
export const STANDARD_FONT_BASE64: Record<string, string> = {
${fontEntries.join('\n')}
}
`,
  'utf8',
)

console.log(
  `[gen-pdfjs-assets] cmaps=${cmapFiles.length} fonts=${fontFiles.length} ` +
    `raw=${(bytes / 1024).toFixed(0)}KB out=${(statSync(outFile).size / 1024).toFixed(0)}KB`,
)
