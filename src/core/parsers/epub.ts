/**
 * EPUB / EPUB3 解析
 * 流程：container.xml → OPF → manifest / spine / toc → 逐章抽取 HTML 并重写资源引用
 * 资源（图片 / 字体 / CSS）统一转为 blob: URL 或内联 <style>，保证离线可读
 */
import JSZip from 'jszip'
import type { BookDoc, Chapter, TocItem } from '../types'
import { blobToDataUrl, htmlToText, sanitizeHtml, titleFromFilename, uid } from '../utils'
import {
  indexZip,
  isImagePath,
  joinPath,
  loadZip,
  normalizePath,
  readZipBlob,
  readZipText,
  zipEntry,
  zipList,
  type ZipIndex,
} from './zipUtils'

/** manifest 条目 */
interface ManifestItem {
  id: string
  href: string
  path: string
  mediaType: string
  properties: string
}

/** 按 localName 取元素，规避命名空间前缀差异 */
function byLocalName(root: Document | Element, name: string): Element[] {
  const all = root.getElementsByTagName('*')
  const result: Element[] = []
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].localName === name) result.push(all[i])
  }
  return result
}

/** 读取元素文本 */
function textOf(el: Element | undefined): string {
  return (el?.textContent ?? '').trim()
}

export async function parseEpub(file: File): Promise<BookDoc> {
  const zip = await loadZip(await file.arrayBuffer())
  const zipper = indexZip(zip)

  // 1. 定位 OPF
  const containerXml = await readZipText(zipper, 'META-INF/container.xml')
  let opfPath = /full-path\s*=\s*"([^"]+)"/i.exec(containerXml)?.[1] ?? ''
  if (!opfPath) {
    const candidates = zipList(zipper, (path) => path.endsWith('.opf'))
    opfPath = candidates[0] ?? ''
  }
  if (!opfPath) throw new Error('EPUB 结构异常：未找到 OPF 包文件')
  const opfDir = opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
  const opfXml = await readZipText(zipper, opfPath)
  const opf = new DOMParser().parseFromString(opfXml, 'application/xml')

  // 2. 元数据
  const metadataEl = byLocalName(opf, 'metadata')[0]
  const title =
    textOf(metadataEl ? byLocalName(metadataEl, 'title')[0] : undefined) ||
    titleFromFilename(file.name)
  const author =
    byLocalName(metadataEl ?? opf, 'creator')
      .map((el) => textOf(el))
      .filter(Boolean)
      .join('、') || ''
  const language = textOf(metadataEl ? byLocalName(metadataEl, 'language')[0] : undefined)

  // 3. manifest / spine
  const manifest = new Map<string, ManifestItem>()
  byLocalName(opf, 'item').forEach((el) => {
    const id = el.getAttribute('id')
    const href = el.getAttribute('href')
    if (!id || !href) return
    manifest.set(id, {
      id,
      href,
      path: joinPath(opfPath, href),
      mediaType: el.getAttribute('media-type') ?? '',
      properties: el.getAttribute('properties') ?? '',
    })
  })

  const spineEl = byLocalName(opf, 'spine')[0]
  const spineItems: Array<{ idref: string; linear: boolean }> = byLocalName(opf, 'itemref').map((el) => ({
    idref: el.getAttribute('idref') ?? '',
    linear: el.getAttribute('linear') !== 'no',
  }))
  const tocId = spineEl?.getAttribute('toc') ?? ''

  // 4. 封面
  let cover = ''
  const coverMetaId = byLocalName(opf, 'meta')
    .find((el) => el.getAttribute('name') === 'cover')
    ?.getAttribute('content')
  const coverItem =
    (coverMetaId ? manifest.get(coverMetaId) : undefined) ??
    Array.from(manifest.values()).find((item) => item.properties.includes('cover-image'))
  if (coverItem) {
    const blob = await readZipBlob(zipper, coverItem.path)
    if (blob) {
      try {
        cover = await blobToDataUrl(blob)
      } catch {
        cover = ''
      }
    }
  }

  // 5. 资源缓存：同一路径只创建一次 blob URL
  const urlCache = new Map<string, string>()
  const toUrl = async (path: string): Promise<string> => {
    const key = normalizePath(path)
    const cached = urlCache.get(key)
    if (cached) return cached
    const blob = await readZipBlob(zipper, path)
    if (!blob) return ''
    const url = URL.createObjectURL(blob)
    urlCache.set(key, url)
    return url
  }

  // 6. 收集并重写全书 CSS（url() 引用转为 blob URL）
  const cssParts: string[] = []
  const cssSeen = new Set<string>()
  const cssItems = Array.from(manifest.values()).filter(
    (item) => item.mediaType.includes('css') || /\.css$/i.test(item.path),
  )
  for (const item of cssItems) {
    const key = normalizePath(item.path)
    if (cssSeen.has(key)) continue
    cssSeen.add(key)
    const raw = await readZipText(zipper, item.path)
    if (!raw) continue
    const rewritten = await replaceUrls(raw, item.path, toUrl)
    cssParts.push(rewritten)
  }

  // 7. 逐章解析正文
  const chapters: Chapter[] = []
  const pathToChapter = new Map<string, number>()
  const warnings: string[] = []

  for (const spineItem of spineItems) {
    if (!spineItem.linear) continue
    const item = manifest.get(spineItem.idref)
    if (!item) continue
    const raw = await readZipText(zipper, item.path)
    if (!raw.trim()) continue

    const doc = parseXhtml(raw)
    const body = doc.body
    if (!body) continue

    // 图片 / SVG 引用改写
    await rewriteResources(body, item.path, toUrl)
    body.querySelectorAll('script, iframe, object, embed, noscript').forEach((el) => el.remove())

    const innerHtml = sanitizeHtml(body.innerHTML)
    const plainText = htmlToText(innerHtml).replace(/\s+/g, ' ').trim()
    if (!plainText && !/<img/i.test(innerHtml)) continue

    const heading = textOf(body.querySelector('h1, h2, h3') ?? undefined)
    const index = chapters.length
    pathToChapter.set(normalizePath(item.path), index)
    chapters.push({
      id: uid(`c${index}`),
      title: heading || `第 ${index + 1} 节`,
      html: innerHtml,
      text: plainText,
    })
  }

  if (!chapters.length) {
    throw new Error('EPUB 正文为空：该文件可能只包含加密或纯图片内容')
  }

  // 8. 目录
  let toc: TocItem[] = []
  const navItem = Array.from(manifest.values()).find((item) => item.properties.includes('nav'))
  if (navItem) {
    const navRaw = await readZipText(zipper, navItem.path)
    toc = parseNavToc(navRaw, navItem.path, pathToChapter)
  }
  if (!toc.length) {
    const ncxItem =
      manifest.get(tocId) ??
      Array.from(manifest.values()).find(
        (item) => item.mediaType.includes('dtbncx') || /\.ncx$/i.test(item.path),
      )
    if (ncxItem) {
      const ncxRaw = await readZipText(zipper, ncxItem.path)
      toc = parseNcxToc(ncxRaw, ncxItem.path, pathToChapter)
    }
  }
  if (!toc.length) {
    toc = chapters.map((chapter, index) => ({ title: chapter.title, level: 0, chapterIndex: index }))
  }
  // 用目录标题回填章节标题，阅读体验更一致
  toc.forEach((item) => {
    const chapter = chapters[item.chapterIndex]
    if (chapter && /^第 \d+ 节$/.test(chapter.title) && item.level === 0) {
      chapter.title = item.title
    }
  })

  if (!cover) cover = await fallbackCover(zipper, toUrl)
  if (!cssParts.length) warnings.push('该书未包含样式表，已使用默认排版')

  return {
    kind: 'flow',
    format: 'epub',
    title,
    author,
    language,
    cover,
    chapters,
    toc,
    cssText: cssParts.join('\n'),
    warnings,
  }
}

/** 解析 XHTML，优先严格模式 */
function parseXhtml(source: string): Document {
  const parser = new DOMParser()
  const xml = parser.parseFromString(source, 'application/xhtml+xml')
  if (xml.querySelector('parsererror')) {
    return parser.parseFromString(source, 'text/html')
  }
  return xml
}

/** 把 CSS 中的 url(...) 替换为可访问地址 */
async function replaceUrls(
  css: string,
  cssPath: string,
  toUrl: (path: string) => Promise<string>,
): Promise<string> {
  const matches = Array.from(css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g))
  let output = css
  for (const match of matches) {
    const rawUrl = match[2].trim()
    if (/^(data:|blob:|https?:)/i.test(rawUrl)) continue
    const resolved = joinPath(cssPath, rawUrl)
    const url = await toUrl(resolved)
    if (url) output = output.replace(match[0], `url("${url}")`)
  }
  return output
}

/** 重写正文中的图片、SVG、音视频引用 */
async function rewriteResources(
  body: HTMLElement,
  docPath: string,
  toUrl: (path: string) => Promise<string>,
): Promise<void> {
  const images = Array.from(body.querySelectorAll('img')) as HTMLImageElement[]
  for (const img of images) {
    const src = img.getAttribute('src') ?? ''
    if (!src || /^(data:|blob:|https?:)/i.test(src)) continue
    const url = await toUrl(joinPath(docPath, src))
    if (url) img.setAttribute('src', url)
    else img.remove()
    img.removeAttribute('loading')
  }

  // SVG <image xlink:href>
  const svgImages = Array.from(body.querySelectorAll('image'))
  for (const node of svgImages) {
    const href = node.getAttribute('xlink:href') ?? node.getAttribute('href') ?? ''
    if (!href || /^(data:|blob:|https?:)/i.test(href)) continue
    const url = await toUrl(joinPath(docPath, href))
    if (url) {
      node.setAttribute('href', url)
      node.setAttribute('xlink:href', url)
    }
  }

  // 内联 style 中的背景图
  const styled = Array.from(body.querySelectorAll('[style*="url("]')) as HTMLElement[]
  for (const el of styled) {
    const style = el.getAttribute('style') ?? ''
    const replaced = await replaceUrls(style, docPath, toUrl)
    el.setAttribute('style', replaced)
  }
}

/** 解析 EPUB3 nav 目录 */
function parseNavToc(
  raw: string,
  navPath: string,
  pathToChapter: Map<string, number>,
): TocItem[] {
  const doc = parseXhtml(raw)
  const navs = Array.from(doc.querySelectorAll('nav'))
  const tocNav =
    navs.find((nav) => (nav.getAttribute('epub:type') ?? nav.getAttribute('type')) === 'toc') ?? navs[0]
  if (!tocNav) return []
  const result: TocItem[] = []
  const walk = (list: Element, level: number) => {
    list.querySelectorAll(':scope > li').forEach((li) => {
      const anchor = li.querySelector(':scope > a')
      if (anchor) {
        const text = textOf(anchor)
        const href = anchor.getAttribute('href') ?? ''
        const index = pathToChapter.get(normalizePath(joinPath(navPath, href)))
        if (text && index !== undefined) result.push({ title: text, level, chapterIndex: index })
      }
      const childList = li.querySelector(':scope > ol, :scope > ul')
      if (childList) walk(childList, level + 1)
    })
  }
  const rootList = tocNav.querySelector('ol, ul')
  if (rootList) walk(rootList, 0)
  return result
}

/** 解析 EPUB2 NCX 目录 */
function parseNcxToc(
  raw: string,
  ncxPath: string,
  pathToChapter: Map<string, number>,
): TocItem[] {
  if (!raw) return []
  const doc = new DOMParser().parseFromString(raw, 'application/xml')
  const result: TocItem[] = []
  const walk = (navPoints: Element[], level: number) => {
    navPoints.forEach((point) => {
      const label = textOf(byLocalName(point, 'navLabel')[0])
      const src = byLocalName(point, 'content')[0]?.getAttribute('src') ?? ''
      const index = pathToChapter.get(normalizePath(joinPath(ncxPath, src)))
      if (label && index !== undefined) result.push({ title: label, level, chapterIndex: index })
      const children = byLocalName(point, 'navPoint').filter((child) => child.parentElement === point)
      if (children.length) walk(children, level + 1)
    })
  }
  walk(byLocalName(doc, 'navPoint').filter((el) => el.parentElement?.localName === 'navMap'), 0)
  return result
}

/** 无显式封面时，取正文第一张图作为封面（返回 dataURL，便于持久化） */
async function fallbackCover(zipper: ZipIndex, _toUrl: (path: string) => Promise<string>): Promise<string> {
  const candidates = zipList(zipper, (path) => isImagePath(path)).slice(0, 6)
  for (const path of candidates) {
    if (!zipEntry(zipper, path)) continue
    const blob = await readZipBlob(zipper, path)
    if (!blob || blob.size > 4 * 1024 * 1024) continue
    try {
      return await blobToDataUrl(blob)
    } catch {
      /* 尝试下一张 */
    }
  }
  return ''
}
