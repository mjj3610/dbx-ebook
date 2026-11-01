/**
 * RTF 解析：剥离控制字，还原纯文本后按章节切分
 * 支持：\par 段落、\'hh 多字节字符（按 \ansicpg 码表）、\uN Unicode、\tab、\line、
 *       忽略字体表/样式表/图片组
 */
import type { BookDoc } from '../types'
import { splitChapters } from '../chapterize'
import { decodeBuffer, titleFromFilename } from '../utils'

/** Windows 代码页 → TextDecoder 标签；未列出时按 GB18030 兜底（中文文档占多数） */
const CODEPAGE_LABELS: Record<string, string> = {
  '437': 'windows-1252',
  '850': 'windows-1252',
  '866': 'ibm866',
  '932': 'shift_jis',
  '936': 'gb18030',
  '949': 'euc-kr',
  '950': 'big5',
  '874': 'windows-874',
  '10000': 'macintosh',
  '1200': 'utf-16le',
  '1250': 'windows-1250',
  '1251': 'windows-1251',
  '1252': 'windows-1252',
  '1253': 'windows-1253',
  '1254': 'windows-1254',
  '1255': 'windows-1255',
  '1256': 'windows-1256',
  '1257': 'windows-1257',
  '1258': 'windows-1258',
  '20866': 'koi8-r',
  '21866': 'koi8-u',
  '28591': 'windows-1252',
  '65001': 'utf-8',
}

/** 代码页 → 可用码表标签 */
function charsetForCodepage(codepage?: string): string {
  if (!codepage) return 'gb18030'
  const label = CODEPAGE_LABELS[codepage]
  if (!label) return 'gb18030'
  try {
    return new TextDecoder(label).encoding
  } catch {
    return 'gb18030'
  }
}

/** 需要整段跳过的目标组（字体表、颜色表、样式表、图片等） */
const SKIP_DESTINATIONS = [
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'header',
  'footer',
  'footnote',
  'themedata',
  'colorschememapping',
  'datastore',
  'latentstyles',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'generator',
  'xmlnstbl',
]

/**
 * 将 RTF 字节解码为纯文本
 * 采用字节级扫描，便于正确处理 \'hh 形式的双字节编码字符（GBK / Big5 / 西文码表）
 */
export function rtfToText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)

  /**
   * \'hh 字节串的码表
   * RTF 头部 \ansicpgN 声明文档代码页（936=GBK、950=Big5、1251=西里尔、65001=UTF-8…）。
   * 中文 RTF 一定带 \ansicpg936；缺省时按 GB18030 兜底，因为中文用户场景占绝大多数。
   */
  const declaredCp = /\\ansicpg(\d{1,5})/.exec(
    new TextDecoder('windows-1252').decode(bytes.subarray(0, 2048)),
  )?.[1]
  const charset = charsetForCodepage(declaredCp)

  const pending: number[] = []
  const output: string[] = []
  const groupStack: boolean[] = []
  let skipDepth = -1
  let index = 0

  /** 冲刷待解码的多字节缓冲 */
  const flushPending = () => {
    if (!pending.length) return
    try {
      output.push(new TextDecoder(charset).decode(new Uint8Array(pending)))
    } catch {
      /* 忽略无法解码的字节 */
    }
    pending.length = 0
  }

  while (index < bytes.length) {
    const byte = bytes[index]

    if (byte === 0x7b) {
      // '{' 进入新组
      groupStack.push(skipDepth >= 0)
      if (skipDepth >= 0) skipDepth += 1
      index += 1
      // 识别 \\* 与目标名
      if (bytes[index] === 0x5c && bytes[index + 1] === 0x2a) {
        index += 2
        let name = ''
        while (index < bytes.length && /[a-zA-Z]/.test(String.fromCharCode(bytes[index]))) {
          name += String.fromCharCode(bytes[index])
          index += 1
        }
        if (SKIP_DESTINATIONS.includes(name)) skipDepth = skipDepth >= 0 ? skipDepth : 1
      } else if (bytes[index] === 0x5c) {
        let name = ''
        let cursor = index + 1
        while (cursor < bytes.length && /[a-zA-Z]/.test(String.fromCharCode(bytes[cursor]))) {
          name += String.fromCharCode(bytes[cursor])
          cursor += 1
        }
        if (SKIP_DESTINATIONS.includes(name)) skipDepth = skipDepth >= 0 ? skipDepth : 1
      }
      continue
    }

    if (byte === 0x7d) {
      flushPending()
      // skipDepth 用 -1 表示“未跳过”；被跳过的组闭合时要回到 -1，
      // 否则会停在 0 而被下面的 `skipDepth >= 0` 误判为仍在跳过，
      // 结果是把字体表之后的整篇正文全部丢弃（真实 RTF 都带字体表）
      if (skipDepth > 0) {
        skipDepth -= 1
        if (skipDepth === 0) skipDepth = -1
      }
      groupStack.pop()
      index += 1
      continue
    }

    if (skipDepth >= 0) {
      index += 1
      continue
    }

    if (byte === 0x5c) {
      // 控制字
      const next = bytes[index + 1]
      if (next === undefined) break
      const char = String.fromCharCode(next)

      if (/[a-zA-Z]/.test(char)) {
        let name = ''
        let cursor = index + 1
        while (cursor < bytes.length && /[a-zA-Z]/.test(String.fromCharCode(bytes[cursor]))) {
          name += String.fromCharCode(bytes[cursor])
          cursor += 1
        }
        let numeric = ''
        if (bytes[cursor] === 0x2d) {
          numeric += '-'
          cursor += 1
        }
        while (cursor < bytes.length && /[0-9]/.test(String.fromCharCode(bytes[cursor]))) {
          numeric += String.fromCharCode(bytes[cursor])
          cursor += 1
        }
        // 跳过控制字后的单个空格（RTF 规定）
        if (bytes[cursor] === 0x20) cursor += 1

        flushPending()
        if (name === 'par' || name === 'line' || name === 'row') output.push('\n')
        else if (name === 'tab') output.push('\t')
        else if (name === 'u') {
          const code = Number(numeric)
          output.push(String.fromCharCode(code < 0 ? code + 65536 : code))
          // \uN 后必须跟替代字符：单字节 '?' 或多字节 \'hh\'hh（中文常见两段）
          if (bytes[cursor] === 0x3f) cursor += 1
          let skipped = 0
          while (skipped < 2 && bytes[cursor] === 0x5c && bytes[cursor + 1] === 0x27) {
            cursor += 4
            skipped += 1
          }
        } else if (name === 'emdash') output.push('—')
        else if (name === 'endash') output.push('–')
        else if (name === 'lquote') output.push('‘')
        else if (name === 'rquote') output.push('’')
        else if (name === 'ldblquote') output.push('“')
        else if (name === 'rdblquote') output.push('”')
        index = cursor
        continue
      }

      if (char === "'") {
        // \'hh 十六进制字节，按文档码表拼成多字节序列
        const hex = String.fromCharCode(bytes[index + 2] ?? 0, bytes[index + 3] ?? 0)
        const value = parseInt(hex, 16)
        if (!Number.isNaN(value)) pending.push(value)
        index += 4
        continue
      }

      // 转义字符：\\ \{ \}
      if (char === '\\' || char === '{' || char === '}') {
        flushPending()
        output.push(char)
        index += 2
        continue
      }

      index += 2
      continue
    }

    if (byte === 0x0d || byte === 0x0a) {
      index += 1
      continue
    }

    if (byte > 0x7f) {
      // 裸高位字节（未转义）同样交给当前码表，之前按 UTF-8 解只会得到替换符
      pending.push(byte)
      index += 1
      continue
    }

    flushPending()
    output.push(String.fromCharCode(byte))
    index += 1
  }

  flushPending()
  return output
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function parseRtf(file: File): Promise<BookDoc> {
  const buffer = await file.arrayBuffer()
  const text = rtfToText(buffer)
  const fallback = titleFromFilename(file.name)
  const chapters = splitChapters(text || '（该 RTF 文件没有可提取的文本内容）', fallback)
  const titleMatch = /\\title\s+([^\\{}]+)/.exec(decodeBuffer(buffer).slice(0, 2000))
  return {
    kind: 'flow',
    format: 'rtf',
    title: titleMatch ? titleMatch[1].trim() : fallback,
    chapters,
    toc: chapters.map((chapter, index) => ({ title: chapter.title, level: 0, chapterIndex: index })),
  }
}
