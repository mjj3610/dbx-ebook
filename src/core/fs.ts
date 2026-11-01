/**
 * 本地文件夹存储（File System Access API 薄封装）
 *
 * 为什么需要它：
 * DBX 宿主沙箱（sandbox="allow-scripts"，origin 为 null）会禁用 IndexedDB，
 * 此时唯一能让书库真正落盘的方式，是让用户显式选择一个本地目录，直接把文件写进去。
 *
 * 设计要点：
 * 1. 只依赖最小接口（DirHandleLike），便于在测试中用内存桩替换真实选择器
 * 2. 目录结构对人类友好：library.json（书库索引）+ books/（原始书籍文件）
 * 3. 权限需要按会话重新确认，调用方通过 ensurePermission 处理
 */

/** 可写文件句柄 */
export interface FileHandleLike {
  readonly name: string
  getFile(): Promise<File>
  createWritable(): Promise<{
    write(data: Blob | string): Promise<void>
    close(): Promise<void>
  }>
}

/** 目录句柄（仅声明本插件用到的成员） */
export interface DirHandleLike {
  readonly name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  values?(): AsyncIterable<FileHandleLike | DirHandleLike>
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

/** 书库索引文件名 */
export const LIBRARY_FILE = 'library.json'
/** 书籍文件目录名 */
export const BOOKS_DIR = 'books'

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirHandleLike>
}

/** 目录选择不可用的原因 */
export type DirectoryBlockReason = 'unsupported' | 'sandboxed' | null

/**
 * 判断能否弹目录选择器，以及不可用的原因
 * - unsupported：浏览器没有 File System Access API
 * - sandboxed：页面处在 sandbox iframe（不透明来源），Chrome 明确禁止打开文件选择器
 *   实测报错：Sandboxed documents aren't allowed to show a file picker
 */
export function directoryBlockReason(): DirectoryBlockReason {
  if (typeof window === 'undefined') return 'unsupported'
  if (typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker !== 'function') {
    return 'unsupported'
  }
  // 不透明来源（沙箱）下 origin 为字符串 "null"
  if (window.location.origin === 'null' || String(window.origin) === 'null') return 'sandboxed'
  return null
}

/** 当前环境是否支持选择本地目录 */
export function supportsDirectory(): boolean {
  return directoryBlockReason() === null
}

/**
 * 弹出目录选择器
 * 必须在用户手势（点击）中调用，否则浏览器会抛 SecurityError
 */
export async function pickDirectory(): Promise<DirHandleLike | null> {
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker
  if (!picker) throw new Error('当前环境不支持选择本地文件夹')
  try {
    return await picker({ mode: 'readwrite' })
  } catch (error) {
    // 用户取消不算失败
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

/**
 * 确认目录读写权限
 * 浏览器在重新打开页面后会收回授权，需要用户再次确认
 */
export async function ensurePermission(handle: DirHandleLike): Promise<boolean> {
  const descriptor = { mode: 'readwrite' as const }
  if (handle.queryPermission) {
    const state = await handle.queryPermission(descriptor)
    if (state === 'granted') return true
  }
  if (handle.requestPermission) {
    const state = await handle.requestPermission(descriptor)
    return state === 'granted'
  }
  return true
}

/** 读取 JSON 文件，不存在时返回 null */
export async function readJson<T>(dir: DirHandleLike, name: string): Promise<T | null> {
  try {
    const handle = await dir.getFileHandle(name)
    const file = await handle.getFile()
    return JSON.parse(await file.text()) as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null
    // 文件存在但内容损坏：记录后按空库处理，避免整库不可用
    console.warn(`[fs] 读取 ${name} 失败`, error)
    return null
  }
}

/** 写入 JSON 文件（覆盖） */
export async function writeJson(dir: DirHandleLike, name: string, value: unknown): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(JSON.stringify(value))
  } finally {
    await writable.close()
  }
}

/** 确保子目录存在 */
export async function ensureDir(dir: DirHandleLike, name: string): Promise<DirHandleLike> {
  return dir.getDirectoryHandle(name, { create: true })
}

/** 写入二进制文件 */
export async function writeBlob(dir: DirHandleLike, name: string, blob: Blob): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
  } finally {
    await writable.close()
  }
}

/** 读取二进制文件，不存在时返回 null */
export async function readBlob(dir: DirHandleLike, name: string): Promise<Blob | null> {
  try {
    const handle = await dir.getFileHandle(name)
    return await handle.getFile()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null
    console.warn(`[fs] 读取 ${name} 失败`, error)
    return null
  }
}

/** 删除文件（不存在时静默忽略） */
export async function removeFile(dir: DirHandleLike, name: string): Promise<void> {
  try {
    await dir.removeEntry(name)
  } catch (error) {
    if (error instanceof DOMException && error.name !== 'NotFoundError') {
      console.warn(`[fs] 删除 ${name} 失败`, error)
    }
  }
}
