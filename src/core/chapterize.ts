/**
 * 章节切分：把整段纯文本按常见中文章节标题切分为阅读单元
 * 适用于 TXT / RTF 等无目录信息的格式
 */
import type { Chapter } from './types'
import { escapeHtml, textToParagraphHtml, uid } from './utils'

/** 单章最大字符数，超过则按段落二次切分，避免超长章节导致分页卡顿 */
const MAX_CHAPTER_CHARS = 120_000

/** 章节标题识别正则：第X章 / Chapter N / 序章 / 番外 等 */
const CHAPTER_TITLE_RE =
  /^[ \t\u3000]*((?:第\s*[0-9零一二三四五六七八九十百千两]{1,8}\s*[章节節回卷篇集部话話])|(?:Chapter|CHAPTER|chapter)\s+[0-9IVXLCivxlc]+|(?:序章|楔子|引子|前言|序言|后记|後記|尾声|尾聲|番外|终章|終章|附录|附錄))[^\n]{0,40}$/

/** 由纯文本构建章节对象 */
export function makeChapter(title: string, text: string, index: number): Chapter {
  return {
    id: uid(`c${index}`),
    title,
    html: textToParagraphHtml(text),
    text,
  }
}

/**
 * 切分章节
 * @param rawText 原始全文
 * @param fallbackTitle 无章节标题时使用的标题前缀
 */
export function splitChapters(rawText: string, fallbackTitle = '正文'): Chapter[] {
  const normalized = rawText.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
  const lines = normalized.split('\n')
  const buckets: Array<{ title: string; lines: string[] }> = []
  let current: { title: string; lines: string[] } = { title: '', lines: [] }

  for (const line of lines) {
    const trimmed = line.trim()
    // 标题通常单独成行且长度有限
    if (trimmed.length > 0 && trimmed.length <= 48 && CHAPTER_TITLE_RE.test(trimmed)) {
      if (current.lines.join('').trim() || current.title) buckets.push(current)
      current = { title: trimmed, lines: [] }
      continue
    }
    current.lines.push(line)
  }
  if (current.lines.join('').trim() || current.title) buckets.push(current)

  // 全书没有可识别标题时，按固定长度切块，避免单章过大
  const hasTitles = buckets.some((bucket) => bucket.title)
  if (!hasTitles) {
    return chunkByLength(normalized, fallbackTitle)
  }

  const chapters: Chapter[] = []
  buckets.forEach((bucket, index) => {
    const text = bucket.lines.join('\n').replace(/^\n+/, '')
    if (!text.trim() && !bucket.title) return
    const title = bucket.title || `${fallbackTitle} ${index + 1}`
    if (text.length > MAX_CHAPTER_CHARS) {
      chapters.push(...chunkByLength(text, title, chapters.length))
    } else {
      chapters.push(makeChapter(title, text, chapters.length))
    }
  })

  // 首章若为空（书名页），补一个占位避免空白
  if (!chapters.length) {
    chapters.push(makeChapter(fallbackTitle, normalized.slice(0, MAX_CHAPTER_CHARS) || '（空文件）', 0))
  }
  return chapters
}

/** 按段落累积长度切块，保证不切断段落 */
export function chunkByLength(text: string, titlePrefix: string, startIndex = 0): Chapter[] {
  const paragraphs = text.split(/\n/)
  const chunks: string[] = []
  let buffer: string[] = []
  let size = 0

  for (const paragraph of paragraphs) {
    buffer.push(paragraph)
    size += paragraph.length + 1
    if (size >= MAX_CHAPTER_CHARS) {
      chunks.push(buffer.join('\n'))
      buffer = []
      size = 0
    }
  }
  if (buffer.join('').trim()) chunks.push(buffer.join('\n'))

  return chunks.map((chunk, index) =>
    makeChapter(`${titlePrefix}（${index + 1}）`, chunk, startIndex + index),
  )
}

/** 由 HTML 片段直接构建章节（标题从 h1~h6 提取，取不到则用默认标题） */
export function makeChapterFromHtml(html: string, fallbackTitle: string, index: number): Chapter {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    id: uid(`c${index}`),
    title: fallbackTitle,
    html,
    text,
  }
}

/** 从 HTML 中提取首个标题文本 */
export function extractHeading(html: string): string {
  const match = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html)
  if (!match) return ''
  return match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

/** 纯文本包装为单个完整 HTML 文档（用于 HTML 格式解析） */
export function plainTextDocument(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, '</p><p>')}</p>`
}
