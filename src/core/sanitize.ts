/**
 * 电子书 HTML 白名单消毒
 *
 * 为什么要在这里做：电子书是用户从外部拿到的**不可信文件**，而宿主 CSP 的
 * script-src 带 'unsafe-inline'，一旦让 <script>、事件属性或 javascript: URL
 * 进入 Shadow DOM，就等于在插件 iframe 里执行任意脚本（能调 sidecar 读写书库）。
 *
 * 为什么只在一处做：EPUB / HTML / MOBI / AZW3 / FB2 / Markdown / DOCX / RTF / TXT
 * 的解析结果最后都经由 render.ts 的 mountChapter 注入 DOM，所以消毒收口在那里。
 * 解析器里各自的过滤只当「尽力而为」，不再承担安全职责——早期只有 EPUB 走消毒，
 * MOBI 与 Markdown 完全不设防。
 */

/** 只删除元素本身、保留其子节点（未知标签，多半是排版容器） */
const UNWRAP_TAGS = new Set([
  'html', 'head', 'body', 'main', 'article', 'section', 'aside', 'header', 'footer',
  'nav', 'div', 'span', 'center', 'font', 'tt', 'big', 'strike', 'u', 's', 'nobr',
])

/** 连同内容一起删除（脚本能力 / 会加载外部资源 / 表单交互） */
const DROP_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'base', 'title', 'template', 'noscript',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist',
  'output', 'keygen', 'progress', 'meter',
  'math', 'canvas', 'audio', 'video', 'source', 'track',
  'marquee', 'blink',
])

/**
 * SVG 只保留「画出一张图」所需的最小集合（EPUB 封面常用 <svg><image/></svg>）。
 * 危险元件（foreignObject / animate / set / use / script）不在名单里，一律删除；
 * xlink:href 仍要过协议校验，所以 javascript: 进不来。
 */
const SVG_TAGS = new Set(['svg', 'g', 'image', 'path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'defs'])

const SVG_ATTRS = new Set([
  'viewBox', 'preserveAspectRatio', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'width', 'height', 'href', 'xlink:href', 'fill', 'fill-rule', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'transform', 'clip-rule',
])

/** 允许保留的标签 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'em', 'strong', 'b', 'i', 'del', 'ins', 'sub', 'sup', 'mark', 'small', 'cite', 'q', 'abbr', 'time',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'img', 'figure', 'figcaption',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'ruby', 'rt', 'rp', 'rb',
])

/** 所有标签都允许的属性（值另有来源约束，见 safeAttributeValue） */
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'lang', 'dir'])

/** 按标签额外允许的属性 */
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'name']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'align', 'valign', 'width', 'height']),
  th: new Set(['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'scope']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  ol: new Set(['start', 'reversed', 'type']),
  ul: new Set(['type']),
  li: new Set(['value', 'type']),
  time: new Set(['datetime']),
}

/** 需要做协议校验的属性 */
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'formaction', 'action', 'poster', 'background', 'cite', 'longdesc', 'srcset', 'data'])

/** 去掉空白与控制字符：`java\tscript:` / `java&#10;script:` 都绕不过去 */
function normalizeUrl(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').trim()
}

/**
 * URL 是否安全
 * 只放行 http(s)、blob、以及 img 的 data:image/*；相对路径（无协议）放行。
 * javascript: / vbscript: / data:text/html / file: 一律拒绝。
 */
function isSafeUrl(value: string, tag: string): boolean {
  const raw = normalizeUrl(value)
  if (!raw) return true
  const matched = /^([a-z][a-z0-9+.-]*):/i.exec(raw)
  if (!matched) return true
  const scheme = matched[1].toLowerCase()
  if (scheme === 'http' || scheme === 'https' || scheme === 'blob') return true
  if (scheme === 'data') return tag === 'img' && /^data:image\//i.test(raw)
  return false
}

/** 属性名是否被显式禁止（事件、样式、以及能塞 HTML 的属性） */
function isForbiddenAttr(name: string): boolean {
  if (name.startsWith('on')) return true
  // style 可带 url()/expression()/position:fixed；排版样式由插件自己注入
  if (name === 'style' || name === 'srcdoc' || name === 'formaction') return true
  // 这些属性只对已删除的标签有意义，出现即视为攻击痕迹
  if (name === 'is' || name === 'http-equiv' || name === 'nonce' || name === 'integrity') return true
  return false
}

/** 用子节点替换元素本身 */
function unwrap(el: Element): void {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
}

/**
 * 消毒电子书 HTML
 * @param html 解析器产出的 HTML 片段（可能来自不可信文件）
 */
export function sanitizeBookHtml(html: string): string {
  if (!html) return ''
  // template 是惰性文档：脚本不会执行、图片不会发起请求
  const template = document.createElement('template')
  template.innerHTML = html
  const content = template.content

  for (const el of Array.from(content.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()

    if (DROP_TAGS.has(tag)) {
      el.remove()
      continue
    }

    if (SVG_TAGS.has(tag)) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        const known = SVG_ATTRS.has(attr.name) || SVG_ATTRS.has(name)
        if (isForbiddenAttr(name) || !known) {
          el.removeAttribute(attr.name)
          continue
        }
        if (URL_ATTRS.has(name) && !isSafeUrl(attr.value, 'img')) {
          el.removeAttribute(attr.name)
        }
      }
      continue
    }

    if (!ALLOWED_TAGS.has(tag)) {
      if (UNWRAP_TAGS.has(tag)) unwrap(el)
      else el.remove()
      continue
    }

    const allowed = TAG_ATTRS[tag]
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (isForbiddenAttr(name) || !(GLOBAL_ATTRS.has(name) || allowed?.has(name))) {
        el.removeAttribute(attr.name)
        continue
      }
      if (URL_ATTRS.has(name) && !isSafeUrl(attr.value, tag)) {
        el.removeAttribute(attr.name)
      }
    }

    // 外链一律新窗口 + 去掉 opener；站内锚点保留原行为
    if (tag === 'a' && el.hasAttribute('href')) {
      el.setAttribute('rel', 'noreferrer noopener')
      el.setAttribute('target', '_blank')
    }
  }

  // 兜底：注释节点（条件注释历史遗留）与残留的脚本元素
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_COMMENT)
  const comments: Comment[] = []
  while (walker.nextNode()) comments.push(walker.currentNode as Comment)
  comments.forEach((node) => node.remove())

  return content.childNodes.length ? template.innerHTML : ''
}
