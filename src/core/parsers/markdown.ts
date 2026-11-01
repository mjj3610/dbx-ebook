/**
 * Markdown 解析：内置轻量渲染器（标题 / 强调 / 列表 / 引用 / 代码 / 链接 / 分隔线）
 * 不引入 markdown 依赖，减小插件体积
 */
import type { BookDoc } from '../types'
import { makeChapterFromHtml } from '../chapterize'
import { decodeMarkup, escapeHtml, titleFromFilename } from '../utils'

/** 行内元素渲染：粗体、斜体、行内代码、删除线、链接、图片 */
function renderInline(text: string): string {
  let output = escapeHtml(text)
  output = output.replace(/`([^`]+)`/g, '<code>$1</code>')
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  output = output.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  output = output.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="md-image">[图片：$1]</span>')
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  return output
}

/** 将 Markdown 文本渲染为 HTML */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let inCode = false
  let listType: 'ul' | 'ol' | null = null
  let inQuote = false

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }
  const closeQuote = () => {
    if (inQuote) {
      html.push('</blockquote>')
      inQuote = false
    }
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList()
      closeQuote()
      html.push(inCode ? '</pre>' : '<pre class="md-code">')
      inCode = !inCode
      continue
    }
    if (inCode) {
      html.push(`${escapeHtml(line)}\n`)
      continue
    }
    if (!line.trim()) {
      closeList()
      closeQuote()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      closeQuote()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`)
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList()
      closeQuote()
      html.push('<hr/>')
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      closeList()
      if (!inQuote) {
        html.push('<blockquote>')
        inQuote = true
      }
      html.push(`<p>${renderInline(quote[1])}</p>`)
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (ordered || unordered) {
      closeQuote()
      const type = ordered ? 'ol' : 'ul'
      if (listType !== type) {
        closeList()
        html.push(`<${type}>`)
        listType = type
      }
      html.push(`<li>${renderInline((ordered ?? unordered)?.[1] ?? '')}</li>`)
      continue
    }
    closeList()
    closeQuote()
    html.push(`<p>${renderInline(line)}</p>`)
  }

  closeList()
  closeQuote()
  if (inCode) html.push('</pre>')
  return html.join('\n')
}

export async function parseMarkdown(file: File): Promise<BookDoc> {
  const source = decodeMarkup(await file.arrayBuffer())
  const title = titleFromFilename(file.name)
  // 按一级/二级标题拆分章节
  const sections: Array<{ title: string; body: string[] }> = []
  let current: { title: string; body: string[] } = { title, body: [] }

  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^(#{1,2})\s+(.+)$/.exec(line)
    if (heading) {
      if (current.body.join('').trim()) sections.push(current)
      current = { title: heading[2].trim(), body: [] }
      continue
    }
    current.body.push(line)
  }
  if (current.body.join('').trim() || !sections.length) sections.push(current)

  const chapters = sections.map((section, index) =>
    makeChapterFromHtml(renderMarkdown(section.body.join('\n')), section.title, index),
  )

  return {
    kind: 'flow',
    format: 'md',
    title,
    chapters,
    toc: chapters.map((chapter, index) => ({ title: chapter.title, level: 0, chapterIndex: index })),
  }
}
