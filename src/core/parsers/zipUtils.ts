/**
 * ZIP 相关公共工具（EPUB / CBZ / FBZ / DOCX / ODT 共用）
 */
import JSZip from 'jszip'
import { decodeBuffer, decodeMarkup } from '../utils'

/**
 * 打开 ZIP（统一入口，修正非 UTF-8 文件名）
 *
 * ZIP 里文件名的编码靠“通用位标记”区分：置位表示 UTF-8，未置位理论上按 CP437。
 * 而中文环境打出来的包（老 WinRAR、部分国产工具）通常是 GBK 且不带标记，
 * JSZip 默认按 UTF-8 解码就会得到一堆 U+FFFD：
 *   - EPUB：OPF 里 href（按 GBK 正确解码）与包内条目名（按 UTF-8 错解）对不上，
 *     正文文件全部“找不到”，表现为空白页；
 *   - CBZ：页序与页码名错乱。
 * 这里把未标记的条目名交给 decodeBuffer 自动识别（UTF-8 / GB / Big5）。
 */
export async function loadZip(data: ArrayBuffer | Blob): Promise<JSZip> {
  return JSZip.loadAsync(data, {
    decodeFileName: (bytes) => {
      // optimizedBinaryString 模式下拿到的是字符串数组，其余情况是字节数组
      const source =
        bytes instanceof Uint8Array
          ? bytes
          : Uint8Array.from(Array.from(bytes as string[], (ch) => ch.charCodeAt(0) & 0xff))
      const copy = new Uint8Array(source.length)
      copy.set(source)
      return decodeBuffer(copy.buffer)
    },
  })
}

/** 扩展名 → MIME 映射（覆盖电子书常见图片格式） */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  css: 'text/css',
  js: 'text/javascript',
  html: 'text/html',
  xhtml: 'application/xhtml+xml',
  xml: 'application/xml',
  ncx: 'application/xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

/** 由路径推断 MIME */
export function mimeOf(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path)
  const ext = match ? match[1].toLowerCase() : ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 是否为图片路径 */
export function isImagePath(path: string): boolean {
  return /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(path)
}

/** ZIP 路径索引：兼容大小写差异与 URL 编码 */
export interface ZipIndex {
  zip: JSZip
  /** 小写规范化路径 → 真实条目名 */
  map: Map<string, string>
}

/** 构建索引 */
export function indexZip(zip: JSZip): ZipIndex {
  const map = new Map<string, string>()
  Object.keys(zip.files).forEach((name) => {
    const entry = zip.files[name]
    if (entry.dir) return
    map.set(normalizePath(name), name)
  })
  return { zip, map }
}

/** 规范化路径：解码 %20 等、去掉 ./、统一小写 */
export function normalizePath(path: string): string {
  let result = path.replace(/\\/g, '/').replace(/^\.\//, '')
  try {
    result = decodeURIComponent(result)
  } catch {
    /* 保留原样 */
  }
  return result.toLowerCase()
}

/**
 * 路径拼接：把 href 相对 base 解析为绝对路径，处理 ../ 与 ./
 * @param base 当前文件路径（如 OEBPS/text/ch1.xhtml）
 * @param href 引用路径（如 ../images/a.jpg）
 */
export function joinPath(base: string, href: string): string {
  if (/^[a-z]+:/i.test(href)) return href
  const cleaned = href.split('#')[0].replace(/\\/g, '/')
  const dir = cleaned.startsWith('/') ? '' : base.slice(0, base.lastIndexOf('/') + 1)
  const stack = dir.split('/').filter(Boolean)
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

/**
 * 按路径读取文本
 *
 * 不能直接用 entry.async('string')：JSZip 强制按 UTF-8 解码，
 * 遇到 GBK/Big5 编码的 XHTML、OPF、FB2 会整篇变成替换字符（乱码）。
 * 这里先取原始字节，再按文件头部声明的码表解码。
 */
export async function readZipText(zipper: ZipIndex, path: string): Promise<string> {
  const entry = zipEntry(zipper, path)
  if (!entry) return ''
  return decodeMarkup(await entry.async('arraybuffer'))
}

/** 按路径读取二进制 */
export async function readZipBlob(zipper: ZipIndex, path: string): Promise<Blob | null> {
  const entry = zipEntry(zipper, path)
  if (!entry) return null
  const buffer = await entry.async('arraybuffer')
  return new Blob([buffer], { type: mimeOf(path) })
}

/** 获取条目对象 */
export function zipEntry(zipper: ZipIndex, path: string): JSZip.JSZipObject | null {
  const key = normalizePath(path)
  const real = zipper.map.get(key)
  if (real) return zipper.zip.file(real)
  // 退化匹配：忽略目录前缀差异
  const basename = key.split('/').pop() ?? ''
  for (const [normalized, original] of zipper.map) {
    if (normalized.endsWith(`/${basename}`) || normalized === basename) {
      return zipper.zip.file(original)
    }
  }
  return null
}

/** 列出满足条件的文件路径（真实路径） */
export function zipList(zipper: ZipIndex, predicate: (path: string) => boolean): string[] {
  const result: string[] = []
  for (const [normalized, original] of zipper.map) {
    if (predicate(normalized)) result.push(original)
  }
  return result
}
