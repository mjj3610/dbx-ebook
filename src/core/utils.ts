/**
 * 通用工具函数集合
 */

/** 生成短随机 ID。使用 crypto.randomUUID，降级为时间戳 + 随机数 */
export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return prefix ? `${prefix}_${raw}` : raw
}

/** 字节数格式化：1536 → 1.5 KB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, index)
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/** HTML 转义，防止注入 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}


/** Blob/File 转 dataURL */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(blob)
  })
}

/** 文本转 dataURL（用于生成 SVG 封面等） */
export function textToDataUrl(text: string, mime = 'text/plain'): string {
  try {
    return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`
  } catch {
    return ''
  }
}

/** 读取 Blob 为文本，自动识别编码（UTF-8 / UTF-16 / GB18030） */
export async function decodeText(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  return decodeBuffer(buffer)
}

/** 码表别名 → TextDecoder 认识的标签（浏览器只认 WHATWG 标准名） */
const CHARSET_ALIASES: Record<string, string> = {
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  'unicode': 'utf-16le',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb2312': 'gb18030',
  'gbk': 'gb18030',
  'gb18030': 'gb18030',
  'gb_2312-80': 'gb18030',
  'x-gbk': 'gb18030',
  'cp936': 'gb18030',
  'ms936': 'gb18030',
  'big5': 'big5',
  'big-5': 'big5',
  'big5-hkscs': 'big5',
  'cp950': 'big5',
  'shift_jis': 'shift_jis',
  'shift-jis': 'shift_jis',
  'sjis': 'shift_jis',
  'x-sjis': 'shift_jis',
  'cp932': 'shift_jis',
  'windows-31j': 'shift_jis',
  'euc-jp': 'euc-jp',
  'iso-2022-jp': 'iso-2022-jp',
  'euc-kr': 'euc-kr',
  'ks_c_5601-1987': 'euc-kr',
  'iso-8859-1': 'windows-1252',
  'latin1': 'windows-1252',
  'latin-1': 'windows-1252',
  'windows-1252': 'windows-1252',
  'cp1252': 'windows-1252',
  'windows-1251': 'windows-1251',
  'cp1251': 'windows-1251',
  'koi8-r': 'koi8-r',
  'tis-620': 'windows-874',
  'windows-874': 'windows-874',
}

/** 规范化码表名，返回 TextDecoder 可用标签；未知返回 null */
export function charsetLabel(charset?: string | null): string | null {
  if (!charset) return null
  const key = charset.trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (!key) return null
  if (CHARSET_ALIASES[key]) return CHARSET_ALIASES[key]
  try {
    // 交给浏览器校验，非法名字会抛 RangeError
    return new TextDecoder(key).encoding
  } catch {
    return null
  }
}

/** 严格 UTF-8 校验：非法字节序列返回 false */
export function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * 检测“无 BOM 的 UTF-16”
 * UTF-16 文本里 ASCII 字符的高字节为 0，所以空字节占比很高且集中在奇数位（LE）或偶数位（BE）
 */
function detectUtf16NoBom(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const sample = Math.min(bytes.length, 4096) & ~1
  if (sample < 32) return null
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i < sample; i += 2) {
    if (bytes[i] === 0) evenZero += 1
    if (bytes[i + 1] === 0) oddZero += 1
  }
  const pairs = sample / 2
  if (oddZero / pairs > 0.7 && evenZero / pairs < 0.1) return 'utf-16le'
  if (evenZero / pairs > 0.7 && oddZero / pairs < 0.1) return 'utf-16be'
  return null
}

/**
 * 缓冲区解码：优先 BOM，其次无 BOM 的 UTF-16 探测，再严格 UTF-8 校验，
 * 最后回退 GB18030（覆盖绝大多数中文 TXT）
 */
export function decodeBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  const utf16 = detectUtf16NoBom(bytes)
  if (utf16) return new TextDecoder(utf16).decode(bytes)
  if (isStrictUtf8(bytes)) return new TextDecoder('utf-8').decode(bytes)
  try {
    return new TextDecoder('gb18030').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 按指定码表解码；码表未知或解码失败时回退自动识别 */
export function decodeWithCharset(buffer: ArrayBuffer, charset?: string | null): string {
  const label = charsetLabel(charset)
  if (!label) return decodeBuffer(buffer)
  try {
    return new TextDecoder(label).decode(buffer)
  } catch {
    return decodeBuffer(buffer)
  }
}

/**
 * 从 XML / HTML / CSS 头部嗅探声明的编码
 * 只看前 2KB，够用且不会拖慢大文件
 */
export function sniffCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 2048))
  const patterns = [
    /<\?xml[^>]*?encoding\s*=\s*["']([\w.:-]+)["']/i,
    /<meta[^>]*?charset\s*=\s*["']?([\w.:-]+)["']?/i,
    /@charset\s+["']([\w.:-]+)["']/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(head)
    if (match?.[1]) return match[1]
  }
  return null
}

/**
 * 解码标记类文件（XHTML / XML / HTML / CSS / FB2 / RTF 片段）
 *
 * 声明与实际经常不一致（例如声明 gb2312 实际是 UTF-8），因此：
 * 1. 先看头部声明的码表；
 * 2. 声明不是 UTF-8 但字节恰好是合法 UTF-8 时，采信实际内容；
 * 3. 没有声明则走 decodeBuffer 自动识别。
 */
export function decodeMarkup(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const declared = sniffCharset(bytes)
  const label = charsetLabel(declared)
  if (!label) return decodeBuffer(buffer)
  if (label === 'utf-8') return new TextDecoder('utf-8').decode(bytes)
  if (isStrictUtf8(bytes)) return new TextDecoder('utf-8').decode(bytes)
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return decodeBuffer(buffer)
  }
}

/** 自然排序比较器：img2 排在 img10 之前 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** 数值区间收敛 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

/** 简易节流：同一时间段内只执行最后一次 */
export function debounce<T extends (...args: never[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }) as T
}

/** 计算 Blob 的 SHA-256 指纹（前 16 字节十六进制），用于导入去重 */
export async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return Array.from(new Uint8Array(digest).slice(0, 16))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }
  // 降级：使用长度 + 首尾采样
  return `${buffer.byteLength}-${new Uint8Array(buffer).slice(0, 32).join('')}`
}

/** 从文件名提取书名（去扩展名） */
export function titleFromFilename(filename: string): string {
  // 只去扩展名与首尾空白：用户认的是磁盘上那个名字，任何改写都会让人觉得「导入后名字变了」
  return filename.replace(/\.[^.]+$/, '').trim() || '未命名书籍'
}

/** 取出扩展名（小写，不含点） */
export function extname(filename: string): string {
  const match = /\.([^.]+)$/.exec(filename)
  return match ? match[1].toLowerCase() : ''
}

/**
 * 判断一行是否属于「代码 / 命令」形态
 * 依据：超长不可断词（URL、token）、原文缩进、常见命令名，或高 ASCII 占比且带语法符号。
 * 这类行两端对齐会把空格撑开成巨大间隙，读起来像排版错乱，因此单独标记后改为左对齐 + 任意位置断行。
 */
export function looksLikeCodeLine(raw: string): boolean {
  const line = raw.trim()
  if (!line) return false
  if (/[^\s\u3000]{40,}/.test(line)) return true
  if (/^[\t\u3000]* {2,}\S/.test(raw)) return true
  if (/^(curl|wget|git|npm|npx|pnpm|yarn|docker|kubectl|ssh|scp|sudo|pip|go)\b/.test(line)) return true
  // 高 ASCII 占比 + 明显的语法符号：JSON 片段、参数行、花括号行等
  const asciiRatio = line.replace(/[^\x20-\x7e]/g, '').length / line.length
  if (asciiRatio > 0.85 && /^(?:[-"'{}\[\]#<>]|\/\/)|\s=\s|":\s/.test(line)) return true
  return false
}

/** 将纯文本按段落转为 HTML */
export function textToParagraphHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim()
      if (!line) return '<p class="blank"></p>'
      // 缩进判断要用原始行，trim 之后就看不出缩进了
      const cls = looksLikeCodeLine(raw) ? ' class="code"' : ''
      return `<p${cls}>${escapeHtml(line)}</p>`
    })
    .join('')
}

/** HTML 片段转纯文本 */
export function htmlToText(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return (div.textContent || '').replace(/\u00a0/g, ' ')
}

/** 睡眠指定毫秒（用于退避重试） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 判断是否运行在 Tauri/Electron 等受限 webview（部分能力需降级） */
export function isRestrictedWebview(): boolean {
  return typeof window !== 'undefined' && !window.isSecureContext
}
