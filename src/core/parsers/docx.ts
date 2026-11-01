/**
 * DOCX / ODT 解析
 * DOCX：word/document.xml 按 w:pStyle 判断标题层级，图片经 rels 关联还原
 * ODT：content.xml 按 text:h / text:p 结构还原
 */
import JSZip from 'jszip'
import type { BookDoc, Chapter, TocItem } from '../types'
import { escapeHtml, htmlToText, titleFromFilename, uid } from '../utils'
import { indexZip, loadZip, readZipBlob, readZipText, zipEntry, zipList, type ZipIndex } from './zipUtils'

/** 文档内嵌图片 → dataURL 缓存 */
type ImageResolver = (embedId: string) => Promise<string>

/** 递归取所有同名后代元素 */
function all(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((el) => el.localName === name)
}

/** 取直接子元素 */
function kids(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((el) => el.localName === name)
}

/* ==================== DOCX ==================== */

/** 建立 DOCX 关系表：rId → 目标路径 */
async function buildDocxRels(zipper: ZipIndex): Promise<Map<string, string>> {
  const relsXml = await readZipText(zipper, 'word/_rels/document.xml.rels')
  const map = new Map<string, string>()
  if (!relsXml) return map
  const doc = new DOMParser().parseFromString(relsXml, 'application/xml')
  all(doc, 'Relationship').forEach((el) => {
    const id = el.getAttribute('Id')
    const target = el.getAttribute('Target')
    if (!id || !target) return
    const path = target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`
    map.set(id, path)
  })
  return map
}

/** 段落文本（含制表符与换行） */
function docxParagraphText(paragraph: Element): string {
  let output = ''
  const walk = (node: Element) => {
    Array.from(node.children).forEach((child) => {
      switch (child.localName) {
        case 't':
          output += child.textContent ?? ''
          break
        case 'tab':
          output += '\t'
          break
        case 'br':
        case 'cr':
          output += '\n'
          break
        case 'drawing':
        case 'pict':
          output += '' // 图片另行处理
          break
        default:
          walk(child)
      }
    })
  }
  walk(paragraph)
  return output
}

/** 段落样式名 */
function docxStyleOf(paragraph: Element): string {
  const pPr = kids(paragraph, 'pPr')[0]
  if (!pPr) return ''
  const style = kids(pPr, 'pStyle')[0]
  return (style?.getAttribute('w:val') ?? style?.getAttribute('val') ?? '').toLowerCase()
}

/** 标题层级：1~6，非标题返回 0 */
function headingLevel(styleName: string): number {
  const headingMatch = /^heading\s*(\d)/.exec(styleName)
  if (headingMatch) return Number(headingMatch[1])
  if (/^title$/.test(styleName)) return 1
  if (/^subtitle$/.test(styleName)) return 2
  const cnMatch = /^标题\s*(\d)/.exec(styleName)
  if (cnMatch) return Number(cnMatch[1])
  return 0
}

/** 抽取段落内图片为 <img> */
async function docxImages(paragraph: Element, resolve: ImageResolver): Promise<string> {
  const blips = all(paragraph, 'blip')
  let html = ''
  for (const blip of blips) {
    const embed =
      blip.getAttribute('r:embed') ?? blip.getAttribute('embed') ?? blip.getAttribute('r:link') ?? ''
    if (!embed) continue
    const src = await resolve(embed)
    if (src) html += `<p class="image"><img src="${src}" alt=""/></p>`
  }
  return html
}

export async function parseDocx(file: File): Promise<BookDoc> {
  const zip = await loadZip(await file.arrayBuffer())
  const zipper = indexZip(zip)
  const documentXml = await readZipText(zipper, 'word/document.xml')
  if (!documentXml) throw new Error('DOCX 结构异常：未找到 word/document.xml')

  const rels = await buildDocxRels(zipper)
  const imageCache = new Map<string, string>()
  const resolve: ImageResolver = async (embedId) => {
    const cached = imageCache.get(embedId)
    if (cached !== undefined) return cached
    const target = rels.get(embedId) ?? ''
    const blob = target ? await readZipBlob(zipper, target) : null
    let dataUrl = ''
    if (blob && blob.size < 8 * 1024 * 1024) {
      dataUrl = await new Promise<string>((resolveUrl) => {
        const reader = new FileReader()
        reader.onload = () => resolveUrl(String(reader.result))
        reader.onerror = () => resolveUrl('')
        reader.readAsDataURL(blob)
      })
    }
    imageCache.set(embedId, dataUrl)
    return dataUrl
  }

  const doc = new DOMParser().parseFromString(documentXml, 'application/xml')
  const body = all(doc, 'body')[0]
  if (!body) throw new Error('DOCX 正文为空')

  const chapters: Chapter[] = []
  const toc: TocItem[] = []
  let buffer: string[] = []
  let currentTitle = ''
  let titleDetermined = false

  const flush = () => {
    const html = buffer.join('').trim()
    buffer = []
    if (!html) return
    const plain = htmlToText(html).trim()
    if (!plain && !/<img/i.test(html)) return
    const index = chapters.length
    const title = currentTitle || (index === 0 ? titleFromFilename(file.name) : `第 ${index + 1} 节`)
    chapters.push({ id: uid(`c${index}`), title, html, text: plain })
    if (currentTitle) toc.push({ title, level: 0, chapterIndex: index })
  }

  // 顶层段落与表格按文档顺序遍历
  const blocks: Element[] = []
  const collectBlocks = (parent: Element) => {
    Array.from(parent.children).forEach((child) => {
      if (child.localName === 'p') blocks.push(child)
      else if (child.localName === 'tbl') blocks.push(child)
      else if (child.localName === 'sdt') collectBlocks(child)
      else if (child.localName === 'sdtContent') collectBlocks(child)
    })
  }
  collectBlocks(body)

  for (const block of blocks) {
    if (block.localName === 'tbl') {
      const rows = all(block, 'tr')
      const html = rows
        .map((row) => {
          const cells = kids(row, 'tc').map((cell) => {
            const cellText = all(cell, 'p')
              .map((p) => docxParagraphText(p))
              .join('\n')
              .trim()
            return `<td>${escapeHtml(cellText)}</td>`
          })
          return `<tr>${cells.join('')}</tr>`
        })
        .join('')
      buffer.push(`<table class="docx-table"><tbody>${html}</tbody></table>`)
      continue
    }

    const style = docxStyleOf(block)
    const level = headingLevel(style)
    const paragraphText = docxParagraphText(block).trim()
    const images = await docxImages(block, resolve)

    if (level > 0 && paragraphText) {
      // 一级标题切章，二三级标题保留在正文中
      flush()
      const index = chapters.length
      if (level === 1) {
        currentTitle = paragraphText
        titleDetermined = true
        buffer.push(`<h1>${escapeHtml(paragraphText)}</h1>`)
        continue
      }
      buffer.push(`<h2>${escapeHtml(paragraphText)}</h2>`)
      if (level === 2) toc.push({ title: paragraphText, level: 1, chapterIndex: index })
      continue
    }

    if (paragraphText) {
      buffer.push(`<p>${escapeHtml(paragraphText).replace(/\n/g, '<br/>')}</p>`)
    }
    if (images) buffer.push(images)
  }
  flush()

  if (!chapters.length) throw new Error('DOCX 中未提取到文本内容')

  // 无标题文档：整体作为一章
  if (!titleDetermined && chapters.length > 1) {
    toc.length = 0
    chapters.forEach((chapter, index) => {
      toc.push({ title: chapter.title, level: 0, chapterIndex: index })
    })
  }

  // 封面：优先 docProps/thumbnail
  let cover = ''
  const thumb = zipList(zipper, (path) => path.startsWith('docprops/thumbnails') || path === 'docprops/thumbnail.jpeg')[0]
  if (thumb && zipEntry(zipper, thumb)) {
    const blob = await readZipBlob(zipper, thumb)
    if (blob) {
      cover = await new Promise<string>((resolveUrl) => {
        const reader = new FileReader()
        reader.onload = () => resolveUrl(String(reader.result))
        reader.onerror = () => resolveUrl('')
        reader.readAsDataURL(blob)
      })
    }
  }

  return {
    kind: 'flow',
    format: 'docx',
    title: titleFromFilename(file.name),
    cover,
    chapters,
    toc: toc.length ? toc : chapters.map((chapter, index) => ({ title: chapter.title, level: 0, chapterIndex: index })),
  }
}

/* ==================== ODT ==================== */

/** ODT 文本节点处理：text:s / text:tab / text:line-break 等特殊元素 */
function odtText(node: Element): string {
  let output = ''
  Array.from(node.childNodes).forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      output += child.textContent ?? ''
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const el = child as Element
    switch (el.localName) {
      case 's': {
        const count = Number(el.getAttribute('text:c') ?? '1')
        output += ' '.repeat(Number.isFinite(count) && count > 0 ? count : 1)
        break
      }
      case 'tab':
        output += '\t'
        break
      case 'line-break':
        output += '\n'
        break
      case 'note':
      case 'annotation':
        break
      default:
        output += odtText(el)
    }
  })
  return output
}

export async function parseOdt(file: File): Promise<BookDoc> {
  const zip = await loadZip(await file.arrayBuffer())
  const zipper = indexZip(zip)
  const contentXml = await readZipText(zipper, 'content.xml')
  if (!contentXml) throw new Error('ODT 结构异常：未找到 content.xml')

  const doc = new DOMParser().parseFromString(contentXml, 'application/xml')
  const body = all(doc, 'text')[0] ?? doc.documentElement
  const chapters: Chapter[] = []
  const toc: TocItem[] = []
  let buffer: string[] = []
  let currentTitle = ''

  const flush = () => {
    const html = buffer.join('').trim()
    buffer = []
    if (!html) return
    const plain = htmlToText(html).trim()
    if (!plain) return
    const index = chapters.length
    const title = currentTitle || (index === 0 ? titleFromFilename(file.name) : `第 ${index + 1} 节`)
    chapters.push({ id: uid(`c${index}`), title, html, text: plain })
    if (currentTitle) toc.push({ title, level: 0, chapterIndex: index })
  }

  const walk = (parent: Element) => {
    Array.from(parent.children).forEach((el) => {
      if (el.localName === 'h') {
        flush()
        const level = Number(el.getAttribute('text:outline-level') ?? '1') || 1
        const headingText = odtText(el).trim()
        if (!headingText) return
        if (level === 1) {
          currentTitle = headingText
          buffer.push(`<h1>${escapeHtml(headingText)}</h1>`)
          flush()
          return
        }
        const tag = level === 2 ? 'h2' : 'h3'
        buffer.push(`<${tag}>${escapeHtml(headingText)}</${tag}>`)
        return
      }
      if (el.localName === 'p') {
        const value = odtText(el).trim()
        if (value) buffer.push(`<p>${escapeHtml(value).replace(/\n/g, '<br/>')}</p>`)
        return
      }
      if (el.localName === 'list') {
        const items = Array.from(el.children)
          .filter((child) => child.localName === 'list-item')
          .map((item) => `<li>${escapeHtml(odtText(item).trim())}</li>`)
          .join('')
        if (items) buffer.push(`<ul>${items}</ul>`)
        return
      }
      if (el.localName === 'table') {
        const rows = all(el, 'table-row')
          .map((row) => {
            const cells = Array.from(row.children)
              .filter((child) => child.localName === 'table-cell' || child.localName === 'covered-table-cell')
              .map((cell) => `<td>${escapeHtml(odtText(cell).trim())}</td>`)
              .join('')
            return `<tr>${cells}</tr>`
          })
          .join('')
        if (rows) buffer.push(`<table class="docx-table"><tbody>${rows}</tbody></table>`)
        return
      }
      if (el.localName === 'section' || el.localName === 'text-body' || el.localName === 'frame') {
        walk(el)
      }
    })
  }
  walk(body)

  flush()

  if (!chapters.length) throw new Error('ODT 中未提取到文本内容')

  return {
    kind: 'flow',
    format: 'odt',
    title: titleFromFilename(file.name),
    chapters,
    toc: toc.length ? toc : chapters.map((chapter, index) => ({ title: chapter.title, level: 0, chapterIndex: index })),
  }
}
