/**
 * DBX 宿主桥接
 * 插件在沙箱工作台中运行，以下能力由宿主注入到 window.dbxPlugin：
 * - ready:    初始化完成的 Promise，resolve 出宿主上下文
 * - locale:   宿主界面语言（zh-CN / en …）
 * - theme:    { appearance: 'light' | 'dark', tokens }，同时会以 CSS 变量注入 :root
 * - request:  调用 Host API（如 host.getContext / host.copy）
 * - copy:     写入系统剪贴板（沙箱中 navigator.clipboard 可能不可用，优先走宿主）
 *
 * 本地 `npm run dev`（纯浏览器）下该对象不存在，所有能力自动降级。
 */

/** 宿主主题 */
export interface DbxTheme {
  appearance?: 'light' | 'dark'
  tokens?: Record<string, string>
}

/** 宿主桥接接口（仅声明本插件用到的成员） */
export interface DbxPluginBridge {
  ready: Promise<Record<string, unknown>>
  readonly context: Record<string, unknown>
  readonly locale: string
  readonly theme?: DbxTheme
  request(method: string, params?: unknown): Promise<unknown>
  /** 调用本插件 Sidecar 的 JSON-RPC 方法（宿主未装后端时调用会 reject） */
  invoke?(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  copy(text: string): Promise<unknown>
  onInit?(handler: (context: Record<string, unknown>) => void): () => void
}

declare global {
  interface Window {
    dbxPlugin?: DbxPluginBridge
  }
}

/** 宿主初始化超时（毫秒），避免宿主异常时白屏 */
const READY_TIMEOUT = 1200

/** 是否运行在 DBX 宿主中 */
export function isHosted(): boolean {
  return typeof window !== 'undefined' && Boolean(window.dbxPlugin)
}

/** 取宿主桥接对象 */
export function bridge(): DbxPluginBridge | undefined {
  return typeof window !== 'undefined' ? window.dbxPlugin : undefined
}

/**
 * 等待宿主就绪并应用宿主偏好（语言、深浅色）
 * 未运行在宿主中时立即返回，不影响本地开发
 */
export async function initHostBridge(): Promise<{ appearance: string; locale: string } | null> {
  const host = bridge()
  if (!host) return null
  try {
    await Promise.race([host.ready, new Promise((resolve) => setTimeout(resolve, READY_TIMEOUT))])
  } catch (error) {
    console.warn('[host] 宿主初始化失败，按独立模式运行', error)
    return null
  }
  const applied = applyHostPreferences()
  host.onInit?.(() => applyHostPreferences())
  watchHostTheme(() => applyHostPreferences())
  return applied
}

/**
 * 应用宿主语言与主题
 * 规则：用户未显式选择过语言/主题时，跟随宿主；已选择则尊重用户设置
 *
 * 外观以 `html[data-dbx-theme]` 为准：宿主切换深浅色时**只会更新该属性**，
 * 而 `dbxPlugin.theme.appearance` 可能仍是注入时的旧值，直接采信旧值会导致主题不跟随
 */
export function applyHostPreferences(): { appearance: string; locale: string } {
  const host = bridge()
  const fromDom = document.documentElement.dataset.dbxTheme
  const source = fromDom || host?.theme?.appearance || 'light'
  const appearance = source === 'dark' ? 'dark' : 'light'
  document.documentElement.dataset.appearance = appearance

  const locale = (host?.locale ?? 'zh-CN').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  return { appearance, locale }
}

/** 监听宿主切换外观（宿主只改 data-dbx-theme，不会主动通知插件） */
export function watchHostTheme(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {}
  let applying = false
  const observer = new MutationObserver(() => {
    if (applying) return
    applying = true
    try {
      onChange()
    } finally {
      applying = false
    }
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-dbx-theme'],
  })
  return () => observer.disconnect()
}

/**
 * 复制文本：优先使用宿主能力，降级到浏览器剪贴板
 * @returns 是否成功
 */
export async function copyText(text: string): Promise<boolean> {
  const host = bridge()
  if (host?.copy) {
    try {
      await host.copy(text)
      return true
    } catch {
      /* 继续尝试浏览器剪贴板 */
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * 查询宿主上下文（用于诊断，非必需）
 */
export async function fetchHostContext(): Promise<Record<string, unknown> | null> {
  const host = bridge()
  if (!host) return null
  try {
    return (await host.request('host.getContext')) as Record<string, unknown>
  } catch {
    return null
  }
}
