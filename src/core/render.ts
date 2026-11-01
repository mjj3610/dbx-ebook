/**
 * 正文渲染层
 * 用 Shadow DOM 隔离书籍自带样式，避免污染应用 UI；同时提供：
 * - 统一的排版 CSS（字号 / 行距 / 字体 / 主题）
 * - 高亮锚定（基于渲染后文本的字符偏移，跨文本节点可拆分包裹）
 * - 选中文本偏移计算
 */
import { FONT_FAMILIES, NOTE_COLORS, THEMES } from './constants'
import { sanitizeBookHtml } from './sanitize'
import type { Chapter, NoteRecord, ReaderSettings } from './types'

/** 排版 CSS 变量名，供阅读器动态调整 */
export const READER_VARS = {
  fontSize: '--rd-font-size',
  lineHeight: '--rd-line-height',
  fontFamily: '--rd-font-family',
  color: '--rd-color',
  bg: '--rd-bg',
  link: '--rd-link',
} as const

/** 生成注入 Shadow DOM 的样式表 */
export function buildBookCss(settings: ReaderSettings, bookCssText = ''): string {
  const theme = THEMES[settings.theme]
  const fontFamily = FONT_FAMILIES[settings.fontFamily].css
  const marks = Object.entries(NOTE_COLORS)
    .map(
      ([key, value]) =>
        `.book mark[data-color="${key}"]{background:${value.bg};border-bottom:2px solid ${value.border};color:inherit;padding:0 1px;border-radius:2px;}`,
    )
    .join('\n')

  return `
:host{all:initial;}
.book{
  font-family:${fontFamily};
  font-size:${settings.fontSize}px;
  line-height:${settings.lineHeight};
  color:${theme.text};
  background:transparent;
  word-break:break-word;
  overflow-wrap:break-word;
  text-align:justify;
  -webkit-font-smoothing:antialiased;
  /* 分页模式下 .book 是多栏容器，翻页位移作用在它身上（纸面本身不动） */
  will-change:transform;
  transition:transform .26s cubic-bezier(.33,0,.2,1);
}
.book *{max-width:100%;box-sizing:border-box;}
.book p{margin:0 0 .85em;text-indent:2em;}
.book p.blank{text-indent:0;height:.8em;margin:0;}
/* 代码 / 命令行：两端对齐会把空格撑成巨大间隙，且长 token 需要任意位置断行 */
.book p.code{text-align:left;text-indent:0;word-break:break-all;overflow-wrap:anywhere;white-space:normal;}
.book h1,.book h2,.book h3,.book h4{line-height:1.4;margin:1.2em 0 .7em;font-weight:600;text-indent:0;}
.book h1{font-size:1.5em;}
.book h2{font-size:1.28em;}
.book h3{font-size:1.12em;}
.book h4{font-size:1em;}
.book img{max-width:100%;height:auto;display:block;margin:.6em auto;break-inside:avoid;}
.book p.image{text-indent:0;text-align:center;}
.book blockquote{margin:.8em 0;padding:.2em 0 .2em 1em;border-left:3px solid ${theme.border};color:${theme.sub};}
.book a{color:${theme.text};text-decoration:underline;text-decoration-color:${theme.sub};}
.book hr{border:none;border-top:1px solid ${theme.border};margin:1.2em 0;}
.book ul,.book ol{margin:.6em 0 .8em;padding-left:1.6em;}
.book li{margin:.25em 0;}
.book table{border-collapse:collapse;width:100%;margin:.8em 0;font-size:.94em;}
.book td,.book th{border:1px solid ${theme.border};padding:.35em .5em;}
.book pre{white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.04);padding:.6em;border-radius:4px;font-size:.9em;}
.book code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;}
.book .stanza{margin:.5em 0;padding-left:1em;}
.book .poem{margin:.6em 0;}
.book sup{font-size:.75em;}
.book .tts-active{background:rgba(255,196,0,.28);border-radius:3px;box-shadow:0 0 0 2px rgba(255,196,0,.18);}
${marks}
/* 书籍自带样式（EPUB 内联 CSS） */
${bookCssText}
`
}

/** 挂载章节内容到 Shadow DOM */
export function mountChapter(host: HTMLElement, chapter: Chapter | null, cssText: string): ShadowRoot {
  let root = host.shadowRoot
  if (!root) root = host.attachShadow({ mode: 'open' })
  if (!root) throw new Error('无法创建 Shadow DOM')

  const style = root.querySelector('style') ?? document.createElement('style')
  style.textContent = cssText
  if (!style.parentNode) root.appendChild(style)

  const container = (root.querySelector('.book') as HTMLElement) ?? document.createElement('div')
  container.className = 'book'
  if (!container.parentNode) root.appendChild(container)
  // 唯一注入点：所有格式的正文都在这里落地，因此消毒收口于此（见 sanitize.ts 的说明）
  container.innerHTML = sanitizeBookHtml(chapter?.html ?? '')

  // 为块级元素编号，便于听书高亮定位
  let blockIndex = 0
  Array.from(container.children).forEach((child) => {
    child.setAttribute('data-p', String(blockIndex))
    blockIndex += 1
  })
  return root
}

/** 等待 Shadow 内图片解码完成，保证分页测量准确 */
export async function waitImages(root: ParentNode): Promise<void> {
  const images = Array.from(root.querySelectorAll('img')) as HTMLImageElement[]
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve()
            return
          }
          image.onload = () => resolve()
          image.onerror = () => resolve()
        }),
    ),
  )
}

/** 文本节点清单与拼接后的完整文本 */
interface TextBasis {
  nodes: Text[]
  text: string
}

/** 采集 Shadow 内的全部文本节点（以渲染顺序拼接） */
export function collectText(root: ParentNode): TextBasis {
  const container = root.querySelector('.book')
  if (!container) return { nodes: [], text: '' }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue && node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  })
  const nodes: Text[] = []
  let text = ''
  let current = walker.nextNode()
  while (current) {
    const textNode = current as Text
    nodes.push(textNode)
    text += textNode.nodeValue ?? ''
    current = walker.nextNode()
  }
  return { nodes, text }
}

/** 计算 DOM 位置在整章文本中的绝对偏移 */
export function absoluteOffset(root: ParentNode, node: Node, offset: number): number {
  const { nodes } = collectText(root)
  let total = 0
  for (const textNode of nodes) {
    if (textNode === node) return total + offset
    total += textNode.nodeValue?.length ?? 0
  }
  // node 可能是元素节点，退化为取其起始位置
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element
    for (const textNode of nodes) {
      if (element.contains(textNode)) return total
      total += textNode.nodeValue?.length ?? 0
    }
  }
  return total
}

/** 逐字符包裹指定范围（支持跨多个文本节点） */
function wrapRange(basis: TextBasis, start: number, end: number, color: string, noteId: string): void {
  if (end <= start) return
  let cursor = 0
  // 先收集受影响的节点及局部区间，再从后往前处理，避免偏移失效
  const targets: Array<{ node: Text; from: number; to: number }> = []
  for (const node of basis.nodes) {
    const length = node.nodeValue?.length ?? 0
    const nodeStart = cursor
    const nodeEnd = cursor + length
    cursor = nodeEnd
    if (nodeEnd <= start || nodeStart >= end) continue
    targets.push({
      node,
      from: Math.max(0, start - nodeStart),
      to: Math.min(length, end - nodeStart),
    })
  }

  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const { node, from, to } = targets[i]
    if (to <= from) continue
    try {
      const range = document.createRange()
      range.setStart(node, from)
      range.setEnd(node, to)
      const mark = document.createElement('mark')
      mark.dataset.color = color
      mark.dataset.noteId = noteId
      range.surroundContents(mark)
    } catch {
      /* 极端结构下可能失败，跳过该片段 */
    }
  }
}

/** 在已挂载的章节上应用高亮 */
export function applyNotes(root: ParentNode, notes: NoteRecord[]): void {
  if (!notes.length) return
  // 高亮按偏移从后往前绘制，避免前一次包裹影响后续偏移
  const sorted = [...notes].sort((a, b) => b.start - a.start)
  for (const note of sorted) {
    const basis = collectText(root)
    let start = note.start
    // 校验锚点：内容变动时尝试重新定位
    if (basis.text.slice(start, start + note.text.length) !== note.text) {
      const found = basis.text.indexOf(note.text)
      if (found < 0) continue
      start = found
    }
    wrapRange(basis, start, start + note.text.length, note.color, note.id)
  }
}

/** 清除全部高亮（重新挂载前调用） */
export function clearNotes(root: ParentNode): void {
  root.querySelectorAll('mark[data-note-id]').forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parent.normalize()
  })
}

/** 高亮当前朗读段落 */
export function markSpeechBlock(root: ParentNode, blockIndex: number): void {
  root.querySelectorAll('.tts-active').forEach((el) => el.classList.remove('tts-active'))
  if (blockIndex < 0) return
  const target = root.querySelector(`[data-p="${blockIndex}"]`)
  target?.classList.add('tts-active')
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/** 取当前容器内的选中文本与范围 */
export function readSelection(root: ParentNode): { text: string; start: number; end: number } | null {
  const selection = window.getSelection()
  // 不依赖 isCollapsed：Shadow DOM 下部分浏览器会误报折叠，统一用偏移量判定
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = absoluteOffset(root, range.startContainer, range.startOffset)
  const end = absoluteOffset(root, range.endContainer, range.endOffset)
  if (end <= start) return null
  const { text } = collectText(root)
  return { text: text.slice(start, end), start, end }
}

/** 段落文本列表（听书按段落朗读） */
export function listParagraphs(root: ParentNode): string[] {
  const container = root.querySelector('.book')
  if (!container) return []
  return Array.from(container.children)
    .map((child) => (child.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * 按引文定位并高亮（适用于 PDF 文本层这类没有稳定字符偏移的场景）
 * @returns 是否命中
 */
export function wrapQuote(root: ParentNode, quote: string, color: string, noteId: string): boolean {
  const trimmed = quote.replace(/\s+/g, ' ').trim()
  if (!trimmed) return false
  const basis = collectText(root)
  const index = basis.text.indexOf(trimmed)
  if (index < 0) return false
  wrapRange(basis, index, index + trimmed.length, color, noteId)
  return true
}
