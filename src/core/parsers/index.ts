/**
 * 解析入口：格式识别 + 分发
 */
import { FORMAT_BY_EXT, UNSUPPORTED_HINT } from '../constants'
import type { BookDoc, BookFormat } from '../types'
import { extname } from '../utils'
import { parseComic } from './comic'
import { parseDocx, parseOdt } from './docx'
import { parseEpub } from './epub'
import { parseFb2, parseFbz } from './fb2'
import { parseHtml } from './html'
import { parseMarkdown } from './markdown'
import { parseMobi } from './mobi'
import { parsePdf } from './pdf'
import { parseRtf } from './rtf'
import { parseTxt } from './txt'

/** 支持导入的扩展名列表（用于文件选择框 accept 与文案） */
export const SUPPORTED_EXTENSIONS = Object.keys(FORMAT_BY_EXT)

/** 对外展示的格式清单（按类别） */
export const FORMAT_GROUPS: Array<{ label: string; formats: string[] }> = [
  { label: '主流电子书', formats: ['EPUB', 'PDF', 'MOBI', 'AZW', 'AZW3', 'PRC'] },
  { label: '纯文本类', formats: ['TXT', 'MD', 'RTF', 'HTML', 'XHTML'] },
  { label: '办公文档', formats: ['DOCX', 'ODT'] },
  { label: '其他电子书', formats: ['FB2', 'FBZ'] },
  { label: '漫画书', formats: ['CBZ', 'CBT', 'CBR', 'CB7'] },
]

/**
 * 通过文件头嗅探真实格式（扩展名不可信时兜底）
 */
export async function sniffFormat(file: File): Promise<BookFormat | null> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  // PDF: %PDF
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf'
  // ZIP: PK\x03\x04
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    // ZIP 家族需要进一步查看内部清单，交由扩展名优先判断
    return null
  }
  // RAR: Rar!
  if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) return 'cbr'
  // 7z
  if (head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) return 'cb7'
  // PalmDB / MOBI: 偏移 60 处为 "BOOKMOBI"
  return null
}

/** 识别格式：扩展名优先，其次文件头 */
export async function detectFormat(file: File): Promise<BookFormat> {
  const ext = extname(file.name)
  const byExt = FORMAT_BY_EXT[ext]
  if (byExt) return byExt
  const sniffed = await sniffFormat(file)
  if (sniffed) return sniffed
  // 兜底：按纯文本处理（很多电子书使用自定义后缀）
  return 'txt'
}

/**
 * 解析电子书文件
 * @throws 当格式不支持、文件损坏或加密时抛出可读错误
 */
export async function parseBook(file: File): Promise<BookDoc> {
  const format = await detectFormat(file)
  const hint = UNSUPPORTED_HINT[format]
  if (hint) throw new Error(hint)

  switch (format) {
    case 'epub':
      return parseEpub(file)
    case 'pdf':
      return parsePdf(file)
    case 'txt':
      return parseTxt(file)
    case 'md':
      return parseMarkdown(file)
    case 'html':
      return parseHtml(file)
    case 'rtf':
      return parseRtf(file)
    case 'docx':
      return parseDocx(file)
    case 'odt':
      return parseOdt(file)
    case 'fb2':
      return parseFb2(file)
    case 'fbz':
      return parseFbz(file)
    case 'cbz':
      return parseComic(file, 'cbz')
    case 'cbt':
      return parseComic(file, 'cbt')
    case 'mobi':
    case 'azw':
    case 'azw3':
    case 'prc':
      return parseMobi(file)
    default:
      throw new Error(`暂不支持该文件格式（${format}）`)
  }
}
