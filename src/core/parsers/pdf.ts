/**
 * PDF 解析：基于 pdf.js
 * 负责读取元信息、页数、书签目录，并渲染首页作为封面
 * 逐页渲染与文本提取在阅读器组件中按需执行，避免一次性占用大量内存
 */
import * as pdfjsLib from 'pdfjs-dist'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
import { CMAP_BASE64, STANDARD_FONT_BASE64 } from '../../assets/pdfjs/pdfjs-data.generated'
import type { BookDoc, TocItem } from '../types'
import { titleFromFilename } from '../utils'

/**
 * 指定 worker 地址
 * 必须用 blob: URL 而不是独立文件：
 * DBX 宿主把插件页面放进沙箱 iframe（CSP `script-src 'unsafe-inline' blob:`，default-src 'none'），
 * 既不能加载外部 worker 文件，也不能 fetch 同源资源，只有内联的 blob 可用。
 */
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([workerSource], { type: 'text/javascript' }),
)

/* ------------------------------------------------------------------ *
 * CMap / 标准字体：内存注入
 *
 * 中文 PDF 通常用 CID 字体 + 预定义 CMap（UniGB-UCS2-H、GBK-EUC-H、
 * Adobe-GB1-UCS2…）。pdf.js 默认靠 fetch(cMapUrl) 下载 .bcmap，而宿主
 * 沙箱是 connect-src 'none' + origin 'null'，请求必然失败，于是从 CID
 * 到 Unicode 的映射全断 → 整页乱码。
 *
 * 这里把 .bcmap 与标准字体内联为 base64，通过自定义工厂直接从内存返回
 * 字节：不发任何网络请求，连 blob: URL 都不用。
 * ------------------------------------------------------------------ */

/** base64 → 字节；同一份数据只解码一次并缓存 */
const byteCache = new Map<string, Uint8Array>()

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function lookup(map: Record<string, string>, key: string): Uint8Array | null {
  const hit = byteCache.get(key)
  if (hit) return hit
  const b64 = map[key]
  if (!b64) return null
  const bytes = decodeBase64(b64)
  byteCache.set(key, bytes)
  return bytes
}

/**
 * 自定义 CMap 工厂，替代 DOMCMapReaderFactory
 * 契约：new Factory({baseUrl, isCompressed}) → fetch({name}) → {cMapData, isCompressed}
 */
class InlineCMapReaderFactory {
  private readonly isCompressed: boolean

  constructor({ isCompressed = true }: { baseUrl?: string | null; isCompressed?: boolean } = {}) {
    this.isCompressed = isCompressed
  }

  async fetch({ name }: { name: string }): Promise<{
    cMapData: Uint8Array
    isCompressed: boolean
  }> {
    const data = lookup(CMAP_BASE64, this.isCompressed ? name : `${name}.bcmap`)
    if (!data) throw new Error(`[pdf] 未内置 CMap: ${name}`)
    // 结果会经 postMessage 回传 worker，可能被 transfer，故每次给副本
    return { cMapData: data.slice(), isCompressed: this.isCompressed }
  }
}

/**
 * 自定义标准字体工厂，替代 DOMStandardFontDataFactory
 * 契约：new Factory({baseUrl}) → fetch({filename}) → Uint8Array
 */
class InlineStandardFontDataFactory {
  // pdf.js 会以 { baseUrl } 构造，这里不需要它
  constructor(_options: { baseUrl?: string | null } = {}) {
    void _options
  }

  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    const data = lookup(STANDARD_FONT_BASE64, filename)
    if (!data) throw new Error(`[pdf] 未内置标准字体: ${filename}`)
    return data.slice()
  }
}

/** pdf.js 文档对象类型别名，避免直接依赖内部类型 */
export type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>

/**
 * 判断一段文字看起来是不是「乱码」
 *
 * PDF 字符串按 PDFDocEncoding 解码，而不少国产工具（老版 Word、WPS、若干
 * 打印/扫描驱动）往里塞的其实是 GBK 字节，解出来就是 "Âí¼Ì¾¼" 这种拉丁
 * 补充字符乱飞的形态。这类标题显示在书架上就是用户口中的「乱码」，
 * 与其原样展示，不如退回文件名。
 */
function looksMojibake(text: string): boolean {
  if (!text) return false
  // 正常中文标题不会有这些字符；拉丁补充区与 PDFDocEncoding 的特殊符号是典型特征
  const suspicious = (
    text.match(/[\u00c0-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013-\u203a\u20ac\u2122]/g) ?? []
  ).length
  const visible = text.replace(/\s/g, '').length || 1
  const hasCjk = /[\u4e00-\u9fff]/.test(text)
  // 有汉字就认为已经正确解码；纯拉丁但乱码字符占比超过 15% 才判为乱码
  return !hasCjk && suspicious / visible > 0.15
}

/**
 * 整理 PDF 内嵌标题：去掉 Word / WPS 导出时留下的前缀
 * 这类标题长成 "Microsoft Word - 周报.docx"，直接显示比文件名还难看
 */
function cleanMetaTitle(raw: string): string {
  return raw
    .replace(/^Microsoft\s+(Word|PowerPoint|Excel)\s*[-–—]\s*/i, '')
    .replace(/\.(docx?|pptx?|xlsx?|wps|pdf)$/i, '')
    .trim()
}

/**
 * 文件名是否「没有信息量」：scan001.pdf / 未命名.pdf / 纯数字 / 哈希名
 * 只有这种时候才值得改用 PDF 内嵌标题
 */
function isGenericName(name: string): boolean {
  const text = name.trim()
  if (!text) return true
  if (/^\d+$/.test(text)) return true
  if (/^[0-9a-f]{8,}$/i.test(text)) return true
  if (/^(?:untitled|document|doc|book|ebook|scan|scanned|image|img|file|new|未命名|无标题|新建|文档|扫描|图片|文件)(?:[\s._-]*\d*)$/i.test(text)) {
    return true
  }
  return false
}

/**
 * 打开 PDF 文档（解析与阅读器共用）
 *
 * 注意：一旦传入自定义 CMapReaderFactory / StandardFontDataFactory，
 * pdf.js 内部 useWorkerFetch 自动变为 false，改由主线程用上述工厂取数据，
 * 因此必须提供非空的 cMapUrl（否则 BaseCMapReaderFactory 构造时会报错）。
 *
 * compat=true 时先抹掉内嵌字体程序（见 stripEmbeddedFontPrograms）。
 */
export async function openPdfDocument(data: ArrayBuffer, options: { compat?: boolean } = {}): Promise<PdfDocument> {
  const bytes = options.compat ? stripEmbeddedFontPrograms(new Uint8Array(data)) : new Uint8Array(data)
  // pdf.js 会把数据转移到 Worker，这里保证调用方持有的原始缓冲仍然有效
  const task = pdfjsLib.getDocument({
    data: bytes.slice(0),
    // 保持字体渲染（CID 字体要靠 FontFace 才能真正画出字形）
    disableFontFace: false,
    isEvalSupported: false,
    cMapUrl: 'inline:',
    cMapPacked: true,
    standardFontDataUrl: 'inline:',
    CMapReaderFactory: InlineCMapReaderFactory,
    StandardFontDataFactory: InlineStandardFontDataFactory,
  })
  return task.promise
}

/* ------------------------------------------------------------------ *
 * 字体兼容模式
 *
 * 有的中文 PDF（WPS / 福昕导出常见）把 CID 字体以「子集 + Identity
 * CIDToGIDMap」形式嵌入，而 pdf.js 重建这份字体时打乱了字形索引：
 * 重建后的 cmap 指向的字形与真实字形对不上，整页汉字会变成「每个字都
 * 错成另一个固定的字」，数字与英文却正常（Chrome 自带内核不受影响，
 * 所以同一份文件在 Edge 里是好的）。
 *
 * 这类文件没法从外部修正字形索引，但有一条可靠退路：把内嵌字体程序
 * 从 PDF 里「摘掉」，pdf.js 就会改用 ToUnicode 拿到真实 Unicode 字符、
 * 交给系统字体绘制 —— 字都对、位置对，只是字形变成系统字体。
 *
 * 摘除方式是等长改名（/FontFile2 → /ZontFile2），字节长度不变，
 * 交叉引用表偏移量因此仍然有效，PDF 依旧能被正常解析。
 * ------------------------------------------------------------------ */

/** 需要改名的字体程序键；长键在前，避免 /FontFile 抢先匹配 /FontFile2 */
const FONT_PROGRAM_KEYS: Array<[string, string]> = [
  ['/FontFile2', '/ZontFile2'],
  ['/FontFile3', '/ZontFile3'],
  ['/FontFile', '/ZontFile'],
]

const isPdfWhitespace = (byte: number): boolean => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09

/** 在字节数组里查 ASCII 子串 */
function indexOfAscii(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length
  outer: for (let i = Math.max(0, from); i <= last; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

const asciiBytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/**
 * 抹掉内嵌字体程序：只改「/FontFile2 12 0 R」这种字典键，
 * 且要求后面紧跟「数字 数字 R」，避免误伤二进制流里偶然出现的同样字节。
 */
export function stripEmbeddedFontPrograms(data: Uint8Array): Uint8Array {
  const out = data.slice()
  for (const [from, to] of FONT_PROGRAM_KEYS) {
    const needle = asciiBytes(from)
    const replacement = asciiBytes(to)
    let index = indexOfAscii(out, needle, 0)
    while (index !== -1) {
      const after = index + needle.length
      if (!isPdfWhitespace(out[after] ?? 0)) {
        index = indexOfAscii(out, needle, after)
        continue
      }
      let tail = ''
      for (let i = after; i < Math.min(after + 24, out.length); i += 1) tail += String.fromCharCode(out[i])
      if (!/^\s+\d+\s+\d+\s+R/.test(tail)) {
        index = indexOfAscii(out, needle, after)
        continue
      }
      out.set(replacement, index)
      index = indexOfAscii(out, needle, index + replacement.length)
    }
  }
  return out
}

/** pdf.js 把内嵌字体映射到私用区码位（BMP 0xE000-0xF8FF 或平面 16 0x100000+） */
function isPrivateUseCode(code: number): boolean {
  return (code >= 0xe000 && code <= 0xf8ff) || (code >= 0x100000 && code <= 0x10fffd)
}

/**
 * 判断这份 PDF 是否存在「内嵌字体无法正确映射」的问题
 *
 * 判据：pdf.js 给内嵌字体分配的字形码应当落在私用区；一旦某个字形既不在
 * 私用区、又与它自己的 Unicode 不一致，说明 pdf.js 没拿到映射、退回了原始
 * CID —— 那个码位会被当成普通汉字画出来，于是「每字都错成另一个字」。
 * 这类字形占比超过 10% 就认定需要兼容模式。
 */
export async function detectFontMappingIssue(doc: PdfDocument): Promise<boolean> {
  try {
    const page = await doc.getPage(1)
    const ops = await page.getOperatorList()
    let total = 0
    let suspect = 0
    for (let i = 0; i < ops.fnArray.length; i += 1) {
      if (ops.fnArray[i] !== pdfjsLib.OPS.showText) continue
      const glyphs = ops.argsArray[i][0] as Array<{ fontChar?: string; unicode?: string }>
      for (const glyph of glyphs ?? []) {
        if (!glyph?.fontChar) continue
        const code = glyph.fontChar.codePointAt(0) ?? 0
        total += 1
        if (isPrivateUseCode(code)) continue
        const unicode = glyph.unicode?.codePointAt(0) ?? null
        if (unicode !== null && unicode !== code) suspect += 1
      }
    }
    if (total < 8) return false
    return suspect / total >= 0.1
  } catch {
    return false
  }
}

/** 打开文档，遇到字体映射坏掉的文件自动切到兼容模式 */
export async function openPdfWithAutoCompat(data: ArrayBuffer): Promise<{ doc: PdfDocument; compat: boolean }> {
  const doc = await openPdfDocument(data)
  if (!(await detectFontMappingIssue(doc))) return { doc, compat: false }
  // 坏字体只能靠重开一次解决（字体翻译在 worker 里做，无法热替换）
  doc.destroy().catch(() => undefined)
  const patched = await openPdfDocument(data, { compat: true })
  return { doc: patched, compat: true }
}

/** 递归展开 pdf 大纲 */
function flattenOutline(
  items: Array<{ title: string; dest: unknown; items?: unknown[] }>,
  level: number,
  result: TocItem[],
  pageResolver: (dest: unknown) => number,
): void {
  items.forEach((item) => {
    const page = pageResolver(item.dest)
    result.push({ title: item.title.trim(), level, chapterIndex: page })
    const children = item.items as typeof items | undefined
    if (children?.length) flattenOutline(children, level + 1, result, pageResolver)
  })
}

/** 渲染首页作为封面（返回 dataURL） */
export async function renderPdfCover(doc: PdfDocument, maxWidth = 320): Promise<string> {
  const page = await doc.getPage(1)
  const viewport = page.getViewport({ scale: 1 })
  const scale = Math.min(maxWidth / viewport.width, 2)
  const scaled = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(scaled.width)
  canvas.height = Math.ceil(scaled.height)
  const context = canvas.getContext('2d')
  if (!context) return ''
  await page.render({ canvasContext: context, viewport: scaled }).promise
  try {
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return ''
  }
}

export async function parsePdf(file: File): Promise<BookDoc> {
  const data = await file.arrayBuffer()
  let doc: PdfDocument
  try {
    // 导入时就把封面渲染对：坏字体的 PDF 直接以兼容模式解析，
    // 否则书架上会存下一张「名字全是错的」的封面图
    doc = (await openPdfWithAutoCompat(data)).doc
  } catch (error) {
    // 加密 PDF 会抛 PasswordException，这里换成用户能照做的提示
    if ((error as { name?: string })?.name === 'PasswordException') {
      throw new Error('该 PDF 已加密，需要密码才能打开')
    }
    throw error
  }
  const meta = await doc.getMetadata().catch(() => null)
  const info = (meta?.info ?? {}) as Record<string, unknown>

  const rawTitle = String(info.Title ?? '').trim()
  const rawAuthor = String(info.Author ?? '').trim()
  const metaTitle = rawTitle && !looksMojibake(rawTitle) ? cleanMetaTitle(rawTitle) : ''
  const nameTitle = titleFromFilename(file.name)
  // 文件名优先：用户在磁盘上看到的是它，突然换成 PDF 里那个（往往是 Word 的旧文档属性）
  // 标题会让人觉得「导入后名字变了」。只有文件名本身没信息量时才退回内嵌标题。
  const title = isGenericName(nameTitle) && metaTitle ? metaTitle : nameTitle
  const author = looksMojibake(rawAuthor) ? '' : rawAuthor

  // 目录：dest → 页码
  let toc: TocItem[] = []
  try {
    const outline = (await doc.getOutline()) as
      | Array<{ title: string; dest: unknown; items?: unknown[] }>
      | null
    if (outline?.length) {
      const resolved: TocItem[] = []
      const pageResolver = (dest: unknown): number => {
        if (typeof dest === 'string') return 1
        if (Array.isArray(dest) && dest.length) {
          const ref = dest[0]
          if (typeof ref === 'number') return ref + 1
        }
        return 1
      }
      flattenOutline(outline, 0, resolved, pageResolver)
      // dest 可能为字符串引用，兜底解析一次
      for (const item of resolved) {
        if (item.chapterIndex <= 0) item.chapterIndex = 1
      }
      toc = resolved
    }
  } catch {
    toc = []
  }

  const cover = await renderPdfCover(doc).catch(() => '')

  return {
    kind: 'pdf',
    format: 'pdf',
    title,
    author,
    cover,
    chapters: [],
    pageCount: doc.numPages,
    pdfData: data,
    toc,
  }
}
