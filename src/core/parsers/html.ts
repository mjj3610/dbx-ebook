/**
 * HTML / XHTML / HTM 解析：抽取正文并按 h1~h2 标题切章
 */
import type { BookDoc, Chapter } from '../types'
import { makeChapterFromHtml } from '../chapterize'
import { decodeMarkup, escapeHtml, sanitizeHtml, titleFromFilename } from '../utils'

/** 从完整 HTML 文档中提取标题与正文节点 */
function parseDocument(source: string): Document {
  const parser = new DOMParser()
  // 优先按 XHTML 解析，失败回退 text/html（容错性更强）
  const xmlDoc = parser.parseFromString(source, 'application/xhtml+xml')
  if (xmlDoc.querySelector('parsererror')) {
    return parser.parseFromString(source, 'text/html')
  }
  return xmlDoc
}

export async function parseHtml(file: File): Promise<BookDoc> {
  const source = decodeMarkup(await file.arrayBuffer())
  const doc = parseDocument(source)
  const title = (doc.title || '').trim() || titleFromFilename(file.name)
  const body = doc.body ?? doc.documentElement
  const styleText = Array.from(doc.querySelectorAll('style'))
    .map((node) => node.textContent ?? '')
    .join('\n')

  const chapters: Chapter[] = []
  let buffer: string[] = []
  let currentTitle = title

  const flush = () => {
    const html = buffer.join('').trim()
    buffer = []
    if (!html) return
    const safe = sanitizeHtml(html)
    if (!safe.replace(/<[^>]+>/g, '').trim() && !/<img/i.test(safe)) return
    chapters.push(makeChapterFromHtml(safe, currentTitle, chapters.length))
  }

  Array.from(body.childNodes).forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      const tag = el.tagName.toLowerCase()
      if (tag === 'h1' || tag === 'h2') {
        flush()
        currentTitle = (el.textContent ?? '').trim() || `第 ${chapters.length + 1} 节`
        buffer.push(el.outerHTML)
        return
      }
      if (['script', 'iframe', 'object', 'embed', 'noscript'].includes(tag)) return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      if (!text.trim()) return
      buffer.push(`<p>${escapeHtml(text)}</p>`)
      return
    }
    buffer.push((node as Element).outerHTML ?? '')
  })
  flush()

  if (!chapters.length) {
    chapters.push(makeChapterFromHtml('<p>（该文件没有可显示的正文内容）</p>', title, 0))
  }

  return {
    kind: 'flow',
    format: 'html',
    title,
    cssText: styleText,
    chapters,
    toc: chapters.map((chapter, index) => ({ title: chapter.title, level: 0, chapterIndex: index })),
  }
}
