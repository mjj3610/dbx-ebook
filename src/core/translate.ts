/**
 * 翻译服务
 * 支持两类服务商：
 * 1. openai：任意 OpenAI 兼容接口（/chat/completions），适合私有化部署
 * 2. libre：LibreTranslate 自建或公共服务（/translate）
 * 结果按「目标语言 + 原文」缓存到内存与 IndexedDB，减少重复请求与费用
 */
import { getCache, setCache } from './db'
import { netFetch } from './net'
import { settings } from './settings'

/** 请求超时时间（毫秒） */
const REQUEST_TIMEOUT = 25_000
/** 内存缓存上限 */
const MEMORY_CACHE_LIMIT = 200

const memoryCache = new Map<string, string>()

/** 翻译错误 */
export class TranslateError extends Error {}

/** 缓存键 */
function cacheKey(text: string, target: string): string {
  return `tr:${target}:${text.slice(0, 4000)}`
}

/** 读取缓存 */
async function readCache(key: string): Promise<string | undefined> {
  const local = memoryCache.get(key)
  if (local) return local
  const stored = await getCache<string>(key)
  if (stored) {
    memoryCache.set(key, stored)
    return stored
  }
  return undefined
}

/** 写入缓存 */
async function writeCache(key: string, value: string): Promise<void> {
  memoryCache.set(key, value)
  if (memoryCache.size > MEMORY_CACHE_LIMIT) {
    const oldest = memoryCache.keys().next().value
    if (oldest) memoryCache.delete(oldest)
  }
  await setCache(key, value).catch(() => undefined)
}

/** 带超时的请求（宿主沙箱里 fetch 被 CSP 挡住，统一走 netFetch 由后端代发） */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await netFetch(url, {
      method: init.method,
      headers: init.headers as Record<string, string> | undefined,
      body: init.body as BodyInit | undefined,
      timeoutMs: REQUEST_TIMEOUT,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/timeout|超时|deadline/i.test(message)) {
      throw new TranslateError('翻译请求超时，请检查网络或接口地址')
    }
    throw new TranslateError(`翻译请求失败：${message || '请检查网络连接与接口地址'}`)
  }
}

/** 是否已配置完成 */
export function isTranslateConfigured(): boolean {
  if (settings.translate.provider === 'openai') {
    return Boolean(settings.translate.apiKey && settings.translate.baseUrl)
  }
  return Boolean(settings.translate.libreUrl)
}

/**
 * 翻译文本
 * @param text 原文（建议不超过 3000 字）
 * @returns 译文
 */
export async function translateText(text: string): Promise<string> {
  const content = text.trim()
  if (!content) return ''
  if (!isTranslateConfigured()) {
    throw new TranslateError('尚未配置翻译服务，请在「设置 → 翻译」中填写接口地址与密钥')
  }
  const target = settings.translate.targetLang
  const key = cacheKey(content, target)
  const cached = await readCache(key)
  if (cached) return cached

  const result =
    settings.translate.provider === 'openai' ? await translateByOpenAI(content, target) : await translateByLibre(content, target)

  await writeCache(key, result)
  return result
}

/** OpenAI 兼容接口翻译 */
async function translateByOpenAI(text: string, target: string): Promise<string> {
  const baseUrl = settings.translate.baseUrl.replace(/\/$/, '')
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.translate.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.translate.model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `你是专业的图书翻译。请把用户提供的电子书片段翻译为语言代码 ${target}。只输出译文，保留原文分段，不要添加解释。`,
        },
        { role: 'user', content: text },
      ],
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new TranslateError(`翻译服务返回错误 ${response.status}：${detail.slice(0, 160)}`)
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const output = data.choices?.[0]?.message?.content?.trim()
  if (!output) throw new TranslateError('翻译服务未返回内容')
  return output
}

/** LibreTranslate 翻译 */
async function translateByLibre(text: string, target: string): Promise<string> {
  const url = `${settings.translate.libreUrl.replace(/\/$/, '')}/translate`
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: 'auto', target, format: 'text' }),
  })
  if (!response.ok) {
    throw new TranslateError(`LibreTranslate 返回错误 ${response.status}`)
  }
  const data = (await response.json()) as { translatedText?: string }
  if (!data.translatedText) throw new TranslateError('LibreTranslate 未返回译文')
  return data.translatedText
}
