/**
 * 设置存储：localStorage 持久化 + 全局响应式状态
 * 说明：密钥类字段仅保存在本地，不随备份包导出（安全要求）
 */
import { reactive } from 'vue'
import {
  DEFAULT_READER_SETTINGS,
  DEFAULT_TRANSLATE_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_WEBDAV_SETTINGS,
  LS_READER,
  LS_TRANSLATE,
  LS_TTS,
  LS_WEBDAV,
} from './constants'
import type { ReaderSettings, TranslateSettings, TtsSettings, WebdavSettings } from './types'

/** 全局设置状态 */
export const settings = reactive({
  reader: { ...DEFAULT_READER_SETTINGS } as ReaderSettings,
  tts: { ...DEFAULT_TTS_SETTINGS } as TtsSettings,
  translate: { ...DEFAULT_TRANSLATE_SETTINGS } as TranslateSettings,
  webdav: { ...DEFAULT_WEBDAV_SETTINGS } as WebdavSettings,
})

/** 安全读取 JSON */
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<T>
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

/** 安全写入 JSON */
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn('[settings] 保存设置失败', error)
  }
}

/** 载入全部设置 */
export function loadSettings(): void {
  Object.assign(settings.reader, readJson(LS_READER, DEFAULT_READER_SETTINGS))
  Object.assign(settings.tts, readJson(LS_TTS, DEFAULT_TTS_SETTINGS))
  Object.assign(settings.translate, readJson(LS_TRANSLATE, DEFAULT_TRANSLATE_SETTINGS))
  Object.assign(settings.webdav, readJson(LS_WEBDAV, DEFAULT_WEBDAV_SETTINGS))
}

/**
 * 判断用户是否已显式保存过阅读设置
 * 宿主沙箱可能是不透明来源（sandbox 无 allow-same-origin），访问 localStorage 会抛 SecurityError，
 * 此处必须兜底，否则整个 bootstrap 会中断导致白屏
 */
function hasReaderSettings(): boolean {
  try {
    return Boolean(localStorage.getItem(LS_READER))
  } catch {
    return false
  }
}

/**
 * 首次运行时跟随宿主语言与深浅色
 * 已存在本地阅读设置（用户改过）时不覆盖，保证用户选择优先
 * @param appearance 宿主外观 'light' | 'dark'
 * @param locale 宿主语言
 */
export function applyHostDefaults(appearance: string, locale: 'zh-CN' | 'en'): void {
  if (hasReaderSettings()) return
  settings.reader.locale = locale
  if (appearance === 'dark') settings.reader.theme = 'dark'
}

/** 保存阅读设置 */
export function persistReader(): void {
  writeJson(LS_READER, settings.reader)
}

/** 保存听书设置 */
export function persistTts(): void {
  writeJson(LS_TTS, settings.tts)
}

/** 保存翻译设置 */
export function persistTranslate(): void {
  writeJson(LS_TRANSLATE, settings.translate)
}

/** 保存 WebDAV 设置 */
export function persistWebdav(): void {
  writeJson(LS_WEBDAV, settings.webdav)
}

/** 恢复默认阅读设置 */
export function resetReaderSettings(): void {
  Object.assign(settings.reader, DEFAULT_READER_SETTINGS)
  persistReader()
}
