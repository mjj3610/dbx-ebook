/**
 * FB2 / FBZ 解析
 * FB2 是 XML 结构（FictionBook），FBZ 是其 ZIP 打包版本
 * 章节取自 <body> 下的一级 <section>，内嵌图片从 <binary> 的 base64 还原
 */
import JSZip from 'jszip'
import type { BookDoc, Chapter, TocItem } from '../types'
import { decodeMarkup, escapeHtml, htmlToText, titleFromFilename, uid } from '../utils'
import { indexZip, loadZip, readZipText, zipList } from './zipUtils'

/** XML 元素按 localName 取子元素（仅直接子级） */
function children(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((el) => el.localName === name)
}

/** 取首个同名字孙元素 */
function firstDeep(parent: Element, name: string): Element | undefined {
  return Array.from(parent.getElementsByTagName('*')).find((el) => el.localName === name)
}

/** 元素纯文本 */
function text(el: Element | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** 二进制资源表：id → dataURL */
type BinaryMap = Map<string, string>

/** 汇总所有 <binary> 图片 */
function collectBinaries(doc: Document): BinaryMap {
  const map: BinaryMap = new Map()
  Array.from(doc.getElementsByTagName('*'))
    .filter((el) => el.localName === 'binary')
    .forEach((el) => {
      const id = el.getAttribute('id')
      const contentType = el.getAttribute('content-type') ?? 'image/jpeg'
      const base64 = (el.textContent ?? '').replace(/\s+/g, '')
      if (id && base64) map.set(id, `data:${contentType};base64,${base64}`)
    })
  return map
}

/** 段落级内容转 HTML（递归处理嵌套 section，标题带层级） */
function renderBlock(el: Element, binaries: BinaryMap, level = 0): string {
  const tag = el.localName
  switch (tag) {
    case 'section': {
      const titleEl = firstDeep(el, 'title')
      const heading = titleEl ? text(titleEl) : ''
      let inner = ''
      Array.from(el.children).forEach((child) => {
        if (child.localName === 'title') return
        inner += renderBlock(child, binaries, level + 1)
      })
      const headingTag = level === 0 ? 'h1' : level === 1 ? 'h2' : 'h3'
      return `${heading ? `<${headingTag}>${escapeHtml(heading)}</${headingTag}>` : ''}${inner}`
    }
    case 'title':
      return `<h2>${escapeHtml(text(el))}</h2>`
    case 'p':
      return `<p>${escapeHtml(text(el)) || '&nbsp;'}</p>`
    case 'subtitle':
      return `<h3>${escapeHtml(text(el))}</h3>`
    case 'empty-line':
      return '<p class="blank">&nbsp;</p>'
    case 'epigraph':
    case 'cite':
      return `<blockquote>${Array.from(el.children)
        .map((child) => renderBlock(child, binaries, level))
        .join('')}</blockquote>`
    case 'poem':
      return `<div class="poem">${Array.from(el.children)
        .map((child) => renderBlock(child, binaries, level))
        .join('')}</div>`
    case 'stanza':
      return `<div class="stanza">${children(el, 'v')
        .map((verse) => `<p>${escapeHtml(text(verse))}</p>`)
        .join('')}</div>`
    case 'v':
      return `<p>${escapeHtml(text(el))}</p>`
    case 'image': {
      const href = (el.getAttribute('xlink:href') ?? el.getAttribute('href') ?? '').replace('#', '')
      const src = binaries.get(href)
      return src ? `<p class="image"><img src="${src}" alt=""/></p>` : ''
    }
    case 'table':
      return `<pre>${escapeHtml(text(el))}</pre>`
    default:
      return Array.from(el.children)
        .map((child) => renderBlock(child, binaries, level))
        .join('')
  }
}

/** 从 XML 字符串构建文档 */
export function parseFb2Xml(xml: string, fallbackTitle: string): BookDoc {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('FB2 解析失败：文件不是合法的 XML 结构')
  }
  const binaries = collectBinaries(doc)
  const titleInfo = firstDeep(doc.documentElement, 'title-info')
  const bookTitle = text(titleInfo ? firstDeep(titleInfo, 'book-title') : undefined) || fallbackTitle

  const authorParts: string[] = []
  if (titleInfo) {
    Array.from(titleInfo.getElementsByTagName('*'))
      .filter((el) => el.localName === 'author')
      .slice(0, 1)
      .forEach((author) => {
        const first = text(firstDeep(author, 'first-name'))
        const middle = text(firstDeep(author, 'middle-name'))
        const last = text(firstDeep(author, 'last-name'))
        authorParts.push([first, middle, last].filter(Boolean).join(' '))
      })
  }

  // 封面
  let cover = ''
  const coverpage = titleInfo ? firstDeep(titleInfo, 'coverpage') : undefined
  const coverImage = coverpage ? firstDeep(coverpage, 'image') : undefined
  if (coverImage) {
    const id = (coverImage.getAttribute('xlink:href') ?? coverImage.getAttribute('href') ?? '').replace('#', '')
    cover = binaries.get(id) ?? ''
  }

  // 正文
  const bodies = Array.from(doc.documentElement.children).filter((el) => el.localName === 'body')
  const chapters: Chapter[] = []
  const toc: TocItem[] = []

  bodies.forEach((body) => {
    const sections = children(body, 'section')
    const blocks = sections.length ? sections : [body]
    blocks.forEach((block) => {
      const html = renderBlock(block, binaries, 0)
      const plain = htmlToText(html).trim()
      if (!plain) return
      const heading =
        text(firstDeep(block, 'title')) || (block.localName === 'body' ? bookTitle : `第 ${chapters.length + 1} 节`)
      chapters.push({ id: uid(`c${chapters.length}`), title: heading, html, text: plain })
      toc.push({ title: heading, level: 0, chapterIndex: chapters.length - 1 })
    })
  })

  if (!chapters.length) throw new Error('FB2 正文为空')

  return {
    kind: 'flow',
    format: 'fb2',
    title: bookTitle,
    author: authorParts.join('、'),
    cover,
    chapters,
    toc,
  }
}

export async function parseFb2(file: File): Promise<BookDoc> {
  // FB2 的 XML 声明里常见 encoding="windows-1251"（俄文）或 gb2312，
  // 直接 file.text() 会强制按 UTF-8 解析，正文整篇乱码
  const xml = decodeMarkup(await file.arrayBuffer())
  return parseFb2Xml(xml, titleFromFilename(file.name))
}

export async function parseFbz(file: File): Promise<BookDoc> {
  const zip = await loadZip(await file.arrayBuffer())
  const zipper = indexZip(zip)
  const target = zipList(zipper, (path) => path.endsWith('.fb2'))[0]
  if (!target) throw new Error('FBZ 包内未找到 .fb2 文件')
  const xml = await readZipText(zipper, target)
  const doc = parseFb2Xml(xml, titleFromFilename(file.name))
  doc.format = 'fbz'
  return doc
}
