/**
 * Sidecar 桥接层：真正把数据写进用户磁盘
 *
 * 浏览器沙箱里（iframe 无 allow-same-origin）既没有 IndexedDB，
 * 也调不动 File System Access 的目录选择器，因此前端无法独立完成落盘。
 * DBX 的官方方案是给插件配一个原生 Sidecar（见 backend/main.go），
 * 前端用 window.dbxPlugin.invoke() 走 JSON-RPC 调它，由它用当前用户权限
 * 直接读写磁盘。
 *
 * 这里只做三件事：能力探测、协议封装、分块传输。
 */
import { bridge } from './host'

/** storage/describe 的返回结构 */
export interface SidecarStorageInfo {
  dataDir: string
  root: string
  isDefault: boolean
  exists: boolean
  writable: boolean
  platform: string
  bookCount?: number
  booksBytes?: number
  indexBytes?: number
  /** 换目录时迁移的文件数 */
  migrated?: number
}

/** 分块大小：512KB 原始字节，base64 后约 683KB，远低于协议 8MB 上限 */
const CHUNK_BYTES = 512 * 1024

/** 调用超时：大文件分块写入给足时间 */
const DEFAULT_TIMEOUT = 15000
const WRITE_TIMEOUT = 60000

/** 宿主是否提供了 Sidecar 调用通道 */
export function hasSidecar(): boolean {
  return typeof bridge()?.invoke === 'function'
}

/** 统一的 invoke 封装，错误信息转成可读中文 */
async function call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT): Promise<T> {
  const host = bridge()
  if (typeof host?.invoke !== 'function') throw new Error('当前环境没有可用的原生后端（Sidecar）')
  try {
    return (await host.invoke(method, params, { timeoutMs })) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message || `后端调用失败：${method}`)
  }
}

/** 探测 Sidecar 是否真的可用（没装后端时 invoke 会直接拒绝） */
export async function probeSidecar(): Promise<boolean> {
  if (!hasSidecar()) return false
  try {
    const result = await call<{ ok: boolean }>('ping', {}, 3000)
    return result?.ok === true
  } catch {
    return false
  }
}

/** 读取存储位置信息 */
export function describeStorage(): Promise<SidecarStorageInfo> {
  return call<SidecarStorageInfo>('storage/describe')
}

/** 更换书库目录（absolute path），旧数据会自动迁移 */
export function setStorageRoot(path: string): Promise<SidecarStorageInfo> {
  return call<SidecarStorageInfo>('storage/setRoot', { path }, 60000)
}

/** 恢复默认目录 */
export function resetStorageRoot(): Promise<SidecarStorageInfo> {
  return call<SidecarStorageInfo>('storage/resetRoot', {}, 60000)
}

/** 目录浏览结果 */
export interface DirListing {
  /** 当前目录；空串表示还没进到某个盘/根 */
  path: string
  /** 上级目录；空串表示已在根，不能再往上 */
  parent: string
  entries: Array<{ name: string; path: string }>
  roots: Array<{ name: string; path: string }>
  /** 快捷位置，key 是 i18n key */
  shortcuts: Array<{ key: string; path: string }>
  writable?: boolean
}

/**
 * 列目录
 *
 * 沙箱里 `showDirectoryPicker` 会被直接拒绝（Sandboxed documents aren't
 * allowed to show a file picker），所以「选择文件夹」只能靠 Sidecar 读盘、
 * 在插件里自绘一个目录树。不传 path 时返回盘符与快捷位置。
 */
export function listDirs(path = ''): Promise<DirListing> {
  return call<DirListing>('storage/listDirs', path ? { path } : {}, 15000)
}

/** 在指定目录下新建文件夹，返回新目录绝对路径 */
export function makeDir(parent: string, name: string): Promise<{ path: string }> {
  return call<{ path: string }>('storage/mkdir', { parent, name }, 15000)
}

/** 读取书库索引原文 */
export function readLibraryIndex(): Promise<{ exists: boolean; json: string; size: number }> {
  return call('library/read')
}

/** 写入书库索引原文 */
export function writeLibraryIndex(json: string): Promise<{ size: number; path: string }> {
  return call('library/write', { json }, WRITE_TIMEOUT)
}

/** 书籍文件信息 */
export function statBookFile(name: string): Promise<{ exists: boolean; size: number; path: string }> {
  return call('book/stat', { name })
}

/** 列出磁盘上的书籍文件 */
export function listBookFiles(): Promise<{ books: Array<{ name: string; size: number }>; root: string }> {
  return call('book/list')
}

/** 删除书籍文件 */
export function deleteBookFile(name: string): Promise<{ deleted: boolean; path: string }> {
  return call('book/delete', { name })
}

/** 字节数组 → base64（分段处理，避免超长参数栈） */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/** base64 → 字节数组 */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 分块写入书籍文件（大文件不会一次性进内存） */
export async function writeBookFile(name: string, blob: Blob): Promise<{ size: number; path: string }> {
  let offset = 0
  let result: { size: number; path: string } = { size: 0, path: '' }
  while (offset < blob.size) {
    const slice = blob.slice(offset, Math.min(offset + CHUNK_BYTES, blob.size))
    const bytes = new Uint8Array(await slice.arrayBuffer())
    const chunk = await call<{ written: number; size: number; path: string }>(
      'book/write',
      {
        name,
        offset,
        dataBase64: toBase64(bytes),
        truncate: offset === 0,
      },
      WRITE_TIMEOUT,
    )
    result = { size: chunk.size, path: chunk.path }
    offset += bytes.length
    if (bytes.length === 0) break
  }
  return result
}

/** 分块读回书籍文件 */
export async function readBookFile(name: string): Promise<Blob | undefined> {
  const parts: Uint8Array[] = []
  let offset = 0
  for (;;) {
    const chunk = await call<{
      exists: boolean
      dataBase64: string
      size: number
      nextOffset: number
      eof: boolean
    }>('book/read', { name, offset, length: CHUNK_BYTES }, WRITE_TIMEOUT)
    if (!chunk?.exists) return undefined
    const bytes = fromBase64(chunk.dataBase64)
    if (bytes.length) parts.push(bytes)
    offset = chunk.nextOffset
    if (chunk.eof) break
  }
  return new Blob(parts as BlobPart[])
}
