/**
 * MOBI / AZW / AZW3 / PRC 解析
 * 依据 PalmDB + PalmDOC + MOBI 头部结构解包，还原 HTML 正文后切章
 * 支持压缩算法：1（无压缩）、2（PalmDOC LZ77）
 * 压缩算法 17480（HUFF/CDIC）暂不支持，会给出明确转换建议
 */
import type { BookDoc, Chapter, TocItem } from '../types'
import { makeChapterFromHtml } from '../chapterize'
import { escapeHtml, titleFromFilename, uid } from '../utils'

/** PalmDOC 头部长度 */
const PALM_DOC_HEADER_LEN = 16
/** PalmDB 头部长度 */
const PALMDB_HEADER_LEN = 78
/** 每条记录索引长度 */
const RECORD_ENTRY_LEN = 8
/** 压缩算法：无压缩 */
const COMPRESSION_NONE = 1
/** 压缩算法：PalmDOC LZ77 */
const COMPRESSION_PALMDOC = 2
/** 压缩算法：HUFF/CDIC */
const COMPRESSION_HUFF = 17480

/**
 * 解码 MOBI 正文
 *
 * MOBI 头部只允许两种编码声明：65001（UTF-8）和 1252（cp1252）。
 * 但相当多中文 MOBI 实际用 GBK/GB18030 存正文却仍标 1252，直接按 1252 解
 * 会得到成片的 "Â¡Â¢" 式乱码。这里做一次启发式判定：
 * 按 1252 解码后若高位字符占比过高且换成 GB18030 能还原出大量中日韩汉字，
 * 就认定是中文书籍，改用 GB18030。
 */
function decodeMobiText(bytes: Uint8Array, encoding: string): string {
  const primary = new TextDecoder(encoding).decode(bytes)
  if (encoding !== 'windows-1252') return primary

  const high = primary.match(/[\u0080-\u00ff]/g)?.length ?? 0
  if (high < primary.length * 0.12) return primary

  try {
    const gb = new TextDecoder('gb18030').decode(bytes)
    const cjk = gb.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g)?.length ?? 0
    if (cjk > gb.length * 0.15) return gb
  } catch {
    /* 保持 1252 结果 */
  }
  return primary
}

/** PalmDOC LZ77 解压 */
export function decompressPalmDoc(input: Uint8Array): Uint8Array {
  const output: number[] = []
  let index = 0
  while (index < input.length) {
    const byte = input[index]
    index += 1
    if (byte === 0x00) {
      output.push(0)
    } else if (byte <= 0x08) {
      // 后续 N 个字节原样复制
      for (let i = 0; i < byte && index < input.length; i += 1) {
        output.push(input[index])
        index += 1
      }
    } else if (byte <= 0x7f) {
      output.push(byte)
    } else if (byte <= 0xbf) {
      // 双字节：前 11 位为回溯距离，后 3 位为长度
      if (index >= input.length) break
      const pair = ((byte << 8) | input[index]) & 0x3fff
      index += 1
      const distance = pair >> 3
      const length = (pair & 0x07) + 3
      const start = output.length - distance
      if (distance > 0 && start >= 0) {
        for (let i = 0; i < length; i += 1) {
          output.push(output[start + i])
        }
      }
    } else {
      // 0xc0~0xff：空格 + 单字符
      output.push(0x20, byte ^ 0x80)
    }
  }
  return Uint8Array.from(output)
}

/** 记录集合 */
interface PalmDb {
  records: Uint8Array[]
}

/** 解析 PalmDB 记录表 */
function readPalmDb(buffer: ArrayBuffer): PalmDb {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const recordCount = view.getUint16(PALMDB_HEADER_LEN - 2, false)
  const offsets: number[] = []
  for (let i = 0; i < recordCount; i += 1) {
    const base = PALMDB_HEADER_LEN + i * RECORD_ENTRY_LEN
    if (base + 4 > bytes.length) break
    offsets.push(view.getUint32(base, false))
  }
  const records: Uint8Array[] = []
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : bytes.length
    if (start >= bytes.length) break
    records.push(bytes.subarray(start, Math.min(end, bytes.length)))
  }
  return { records }
}

/** EXTH 记录解析结果 */
interface ExthData {
  /** 作者 */
  author: string
  /** 封面相对偏移 */
  coverOffset: number
  /** 缩略图相对偏移 */
  thumbOffset: number
  /** 更新标题（部分书籍仅 EXTH 有完整书名） */
  title: string
}

/** 解析 EXTH 扩展头 */
function readExth(record0: Uint8Array, start: number): ExthData {
  const result: ExthData = { author: '', coverOffset: -1, thumbOffset: -1, title: '' }
  if (start + 12 > record0.length) return result
  const magic = String.fromCharCode(record0[start], record0[start + 1], record0[start + 2], record0[start + 3])
  if (magic !== 'EXTH') return result

  const view = new DataView(record0.buffer, record0.byteOffset, record0.byteLength)
  const count = view.getUint32(start + 8, false)
  let cursor = start + 12
  for (let i = 0; i < count; i += 1) {
    if (cursor + 8 > record0.length) break
    const type = view.getUint32(cursor, false)
    const length = view.getUint32(cursor + 4, false)
    if (length < 8 || cursor + length > record0.length) break
    const data = record0.subarray(cursor + 8, cursor + length)
    if (type === 100) result.author = new TextDecoder('utf-8').decode(data).trim()
    else if (type === 503) result.title = new TextDecoder('utf-8').decode(data).trim()
    else if (type === 201) result.coverOffset = new DataView(data.buffer, data.byteOffset, data.length).getUint32(0, false)
    else if (type === 202) result.thumbOffset = new DataView(data.buffer, data.byteOffset, data.length).getUint32(0, false)
    cursor += length
  }
  return result
}

/** 嗅探图片类型 */
function sniffImage(data: Uint8Array): string {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e) return 'image/png'
  if (data.length > 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  return ''
}

/** 二进制转 dataURL */
function toDataUrl(data: Uint8Array, mime: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/** MOBI 中的 HTML 还原为章节 */
function htmlToChapters(rawHtml: string, fallbackTitle: string): { chapters: Chapter[]; toc: TocItem[] } {
  let html = rawHtml
    // 分页标记转为分隔线
    .replace(/<mbp:pagebreak[^>]*>/gi, '<hr/>')
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')

  // 统一编码为 UTF-8 之前可能残留的实体
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const container = doc.body.firstElementChild ?? doc.body

  const chapters: Chapter[] = []
  const toc: TocItem[] = []
  let buffer: string[] = []
  let currentTitle = ''

  const flush = () => {
    const chunk = buffer.join('').trim()
    buffer = []
    if (!chunk) return
    const probe = doc.createElement('div')
    probe.innerHTML = chunk
    const plain = (probe.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!plain && !/<img/i.test(chunk)) return
    const index = chapters.length
    const title = currentTitle || (index === 0 ? fallbackTitle : `第 ${index + 1} 节`)
    chapters.push({ id: uid(`c${index}`), title, html: chunk, text: plain })
    toc.push({ title, level: 0, chapterIndex: index })
  }

  Array.from(container.children).forEach((el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'h1' || tag === 'h2') {
      flush()
      currentTitle = (el.textContent ?? '').trim()
      buffer.push(el.outerHTML)
      return
    }
    if (tag === 'hr') {
      flush()
      return
    }
    buffer.push(el.outerHTML)
  })
  flush()

  if (!chapters.length) {
    const plain = (container.textContent ?? '').trim()
    if (!plain) throw new Error('MOBI 正文为空或使用了不支持的压缩算法')
    chapters.push(makeChapterFromHtml(`<p>${escapeHtml(plain)}</p>`, fallbackTitle, 0))
    toc.push({ title: fallbackTitle, level: 0, chapterIndex: 0 })
  }
  return { chapters, toc }
}

export async function parseMobi(file: File): Promise<BookDoc> {
  const buffer = await file.arrayBuffer()
  const db = readPalmDb(buffer)
  if (!db.records.length) throw new Error('文件结构异常：不是有效的 PalmDB / MOBI 文件')

  const record0 = db.records[0]
  const view = new DataView(record0.buffer, record0.byteOffset, record0.byteLength)
  const compression = view.getUint16(0, false)
  const textLength = view.getUint32(4, false)
  const textRecordCount = view.getUint16(8, false)
  const encryption = view.getUint16(12, false)

  if (compression === COMPRESSION_HUFF) {
    throw new Error(
      '该 MOBI/AZW3 使用 HUFF/CDIC 压缩，浏览器内暂无法解包。请用 Calibre 转换为 EPUB 后导入，阅读体验更好。',
    )
  }
  if (compression !== COMPRESSION_NONE && compression !== COMPRESSION_PALMDOC) {
    throw new Error(`不支持的 MOBI 压缩算法（${compression}）`)
  }
  if (encryption !== 0) {
    throw new Error('该电子书带有 DRM 加密，无法解析。请使用已授权设备去除 DRM 后再导入。')
  }

  // MOBI 头部
  let encoding = 'utf-8'
  let title = ''
  let exth: ExthData = { author: '', coverOffset: -1, thumbOffset: -1, title: '' }
  let firstImageIndex = -1

  const mobiSignature = String.fromCharCode(
    record0[PALM_DOC_HEADER_LEN],
    record0[PALM_DOC_HEADER_LEN + 1],
    record0[PALM_DOC_HEADER_LEN + 2],
    record0[PALM_DOC_HEADER_LEN + 3],
  )

  if (mobiSignature === 'MOBI') {
    const headerLength = view.getUint32(PALM_DOC_HEADER_LEN + 4, false)
    const textEncoding = view.getUint32(PALM_DOC_HEADER_LEN + 12, false)
    encoding = textEncoding === 65001 ? 'utf-8' : 'windows-1252'
    firstImageIndex = view.getUint32(PALM_DOC_HEADER_LEN + 92, false)

    const nameOffset = view.getUint32(0x54, false)
    const nameLength = view.getUint32(0x58, false)
    if (nameOffset + nameLength <= record0.length && nameLength > 0 && nameLength < 512) {
      title = new TextDecoder(encoding).decode(record0.subarray(nameOffset, nameOffset + nameLength)).trim()
    }

    const exthFlags = view.getUint32(0x80, false)
    if (exthFlags & 0x40) {
      exth = readExth(record0, PALM_DOC_HEADER_LEN + headerLength)
    }
  }

  // 拼接并解压文本记录
  const chunks: Uint8Array[] = []
  let total = 0
  for (let i = 1; i <= textRecordCount && i < db.records.length; i += 1) {
    const raw = db.records[i]
    if (!raw?.length) continue
    const data = compression === COMPRESSION_NONE ? raw : decompressPalmDoc(raw)
    chunks.push(data)
    total += data.length
    if (textLength && total >= textLength) break
  }
  if (!chunks.length) throw new Error('MOBI 文本记录为空，文件可能已损坏')

  const merged = new Uint8Array(Math.min(total, textLength || total))
  let cursor = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, merged.length - cursor)
    if (take <= 0) break
    merged.set(chunk.subarray(0, take), cursor)
    cursor += take
  }

  const rawHtml = decodeMobiText(merged, encoding)
  const bookTitle = title || exth.title || titleFromFilename(file.name)
  const { chapters, toc } = htmlToChapters(rawHtml, bookTitle)

  // 封面：EXTH 201 为相对首图记录的偏移
  let cover = ''
  if (exth.coverOffset >= 0 && firstImageIndex >= 0) {
    const recordIndex = firstImageIndex + exth.coverOffset
    const imageData = db.records[recordIndex]
    if (imageData) {
      const mime = sniffImage(imageData)
      if (mime) cover = toDataUrl(imageData, mime)
    }
  }

  return {
    kind: 'flow',
    format: (/(\.azw3)$/i.test(file.name) ? 'azw3' : /(\.azw)$/i.test(file.name) ? 'azw' : /(\.prc|\.pdb)$/i.test(file.name) ? 'prc' : 'mobi'),
    title: bookTitle,
    author: exth.author,
    cover,
    chapters,
    toc,
  }
}
