/**
 * 网络访问统一入口
 *
 * 为什么不能直接用 fetch：
 * DBX 宿主把插件页面放进 sandbox iframe，下发的 CSP 是 `connect-src 'none'`，
 * 页面里 fetch 任何外部地址都会抛 "Failed to fetch"（实测，见 scripts/host-net.mjs）。
 * 也就是说中文翻译、WebDAV 备份在真实宿主里必然失败，只有在 `npm run dev` 的
 * 普通浏览器里才碰巧能用。
 *
 * 因此这里统一改走原生 Sidecar：由后端用用户权限直接联网，不受 iframe 的 CSP
 * 限制。好处除了能用，还顺带解决了「宿主只放通白名单域名」——用户可以填任意
 * OpenAI 兼容接口或自建 WebDAV，不必再改 manifest 的 host.network 声明。
 *
 * 没装后端（纯浏览器开发）时自动退回原生 fetch，行为不变。
 */
import { bridge } from './host'
import { hasSidecar, netRequest } from './sidecar'

/** 请求超时：翻译/WebDAV 都可能慢，给足时间 */
const DEFAULT_TIMEOUT = 30000

export interface NetInit {
  method?: string
  headers?: Record<string, string>
  /** 字符串按 UTF-8 编码后发送；也支持 ArrayBuffer / Blob */
  body?: BodyInit | null
  timeoutMs?: number
}

/** 把各种 body 形式统一成字节 */
async function bodyToBytes(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer())
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString())
  }
  // FormData / ReadableStream 这类没法直接序列化，交给原生 fetch 处理
  return null
}

/** 字节转 base64（分块，避免大文件时 apply 参数过多） */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** 当前环境是否必须走后端转发（宿主沙箱里 fetch 被 CSP 挡住） */
export function needsProxy(): boolean {
  return hasSidecar() && typeof bridge() !== 'undefined'
}

/**
 * 发起 HTTP 请求，返回标准 Response
 * 调用方（翻译、WebDAV）不需要关心底层是 fetch 还是后端转发
 */
export async function netFetch(url: string, init: NetInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()

  if (!needsProxy()) {
    return fetch(url, {
      method,
      headers: init.headers,
      body: (init.body ?? undefined) as BodyInit | undefined,
    })
  }

  const bytes = await bodyToBytes(init.body)
  if (init.body != null && bytes === null) {
    throw new Error('该请求体类型无法通过后端转发（仅支持文本、Blob、ArrayBuffer）')
  }

  const result = await netRequest({
    url,
    method,
    headers: init.headers ?? {},
    body: bytes ? toBase64(bytes) : '',
    timeoutMs: init.timeoutMs ?? DEFAULT_TIMEOUT,
  })

  const responseBody = fromBase64(result.body ?? '')
  // HEAD 等无响应体的请求不能构造带 body 的 Response
  const body = method === 'HEAD' ? null : (responseBody as unknown as BodyInit)
  return new Response(body, {
    status: result.status,
    statusText: '',
    headers: result.headers ?? {},
  })
}
