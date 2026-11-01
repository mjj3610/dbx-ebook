/**
 * 本地存储层（四种后端，可运行时切换）
 *
 * 1. SidecarBackend   —— 优先。插件自带原生后端（backend/main.go），以当前用户权限
 *    直接读写磁盘上的书库目录（library.json + books/），位置可在界面上改，
 *    默认落在宿主分配的 DBX_PLUGIN_DATA_DIR/library
 * 2. DirectoryBackend —— 用户通过 File System Access 选择的本地文件夹，
 *    数据同样落成 library.json + books/，适合浏览器环境
 * 3. IdbBackend       —— 浏览器数据库，普通网页环境下默认
 * 4. MemoryBackend    —— 兜底。沙箱禁用 IndexedDB、又没有可用后端时，
 *    保证导入 / 阅读 / 批注 / 导出备份在同一次会话内全部可用
 *
 * 对外 API 与具体后端无关，调用方（书架、阅读器、备份）不需要感知差异。
 */
import { DB_NAME, DB_VERSION, STORE_BOOKS, STORE_KV, STORE_NOTES } from './constants'
import {
  BOOKS_DIR,
  LIBRARY_FILE,
  directoryBlockReason,
  ensureDir,
  readBlob,
  readJson,
  removeFile,
  writeBlob,
  writeJson,
  type DirHandleLike,
} from './fs'
import * as sidecar from './sidecar'
import type { BookFile, BookMeta, NoteRecord } from './types'

/** 文件仓库名（与常量同源，单独声明便于阅读） */
const STORE_FILES = 'files'

/** 仓库名 → 主键字段 */
const PRIMARY_KEY: Record<string, string> = {
  [STORE_BOOKS]: 'id',
  [STORE_FILES]: 'id',
  [STORE_NOTES]: 'id',
  [STORE_KV]: 'key',
}

/* ============ 后端接口 ============ */

interface StorageBackend {
  /** 是否为真正可跨会话保留的存储 */
  readonly persistent: boolean
  get<T>(store: string, key: string): Promise<T | undefined>
  getAll<T>(store: string): Promise<T[]>
  getAllByIndex<T>(store: string, index: string, value: string): Promise<T[]>
  put(store: string, value: unknown): Promise<void>
  remove(store: string, key: string): Promise<void>
  clear(store: string): Promise<void>
}

/* ============ IndexedDB 后端 ============ */

let dbPromise: Promise<IDBDatabase> | null = null

/** 打开数据库（单例） */
function openIdb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        const store = db.createObjectStore(STORE_NOTES, { keyPath: 'id' })
        store.createIndex('bookId', 'bookId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(`打开本地数据库失败：${request.error?.message ?? '未知错误'}`))
    request.onblocked = () => reject(new Error('本地数据库被占用，请关闭其他窗口后重试'))
  })
  return dbPromise
}

/** 通用事务执行器 */
class IdbBackend implements StorageBackend {
  readonly persistent = true

  constructor(private readonly db: IDBDatabase) {}

  private run<T>(
    storeName: string,
    mode: IDBTransactionMode,
    handler: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode)
      const store = tx.objectStore(storeName)
      let request: IDBRequest<T> | void
      try {
        request = handler(store)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('数据库操作失败'))
        return
      }
      tx.oncomplete = () => resolve(request ? request.result : undefined)
      tx.onerror = () => reject(new Error(`数据库事务失败：${tx.error?.message ?? '未知错误'}`))
      tx.onabort = () => reject(new Error('数据库事务被中止'))
    })
  }

  get<T>(store: string, key: string): Promise<T | undefined> {
    return this.run<T>(store, 'readonly', (s) => s.get(key))
  }

  getAll<T>(store: string): Promise<T[]> {
    return this.run<T[]>(store, 'readonly', (s) => s.getAll()).then((list) => list ?? [])
  }

  getAllByIndex<T>(store: string, index: string, value: string): Promise<T[]> {
    return this.run<T[]>(store, 'readonly', (s) => s.index(index).getAll(value)).then((list) => list ?? [])
  }

  put(store: string, value: unknown): Promise<void> {
    return this.run(store, 'readwrite', (s) => s.put(value as never)).then(() => undefined)
  }

  remove(store: string, key: string): Promise<void> {
    return this.run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined)
  }

  clear(store: string): Promise<void> {
    return this.run(store, 'readwrite', (s) => s.clear()).then(() => undefined)
  }
}

/* ============ 内存后端（兜底） ============ */

class MemoryBackend implements StorageBackend {
  readonly persistent = false

  private readonly stores = new Map<string, Map<string, unknown>>()

  private box(store: string): Map<string, unknown> {
    let map = this.stores.get(store)
    if (!map) {
      map = new Map()
      this.stores.set(store, map)
    }
    return map
  }

  async get<T>(store: string, key: string): Promise<T | undefined> {
    return this.box(store).get(key) as T | undefined
  }

  async getAll<T>(store: string): Promise<T[]> {
    return [...this.box(store).values()] as T[]
  }

  async getAllByIndex<T>(store: string, index: string, value: string): Promise<T[]> {
    return [...this.box(store).values()].filter(
      (item) => (item as Record<string, unknown>)[index] === value,
    ) as T[]
  }

  async put(store: string, value: unknown): Promise<void> {
    const key = PRIMARY_KEY[store] ?? 'id'
    const id = (value as Record<string, unknown>)[key]
    this.box(store).set(String(id), value)
  }

  async remove(store: string, key: string): Promise<void> {
    this.box(store).delete(key)
  }

  async clear(store: string): Promise<void> {
    this.box(store).clear()
  }
}

/* ============ 文件型书库（本地文件夹 / Sidecar 共用） ============ */

/** library.json 结构 */
interface LibraryFile {
  version: 1
  savedAt: number
  books: BookMeta[]
  notes: NoteRecord[]
  kv: Array<{ key: string; value: unknown }>
  /** 书籍文件名索引，便于删除与人工查看 */
  files: Array<{ id: string; name: string }>
}

/**
 * 文件仓库端口
 * 把「一个索引文件 + books/ 目录」的读写抽象出来，
 * 上层的书库逻辑同一套代码既能跑在浏览器目录句柄上，也能跑在原生 Sidecar 上。
 */
interface FileStore {
  loadIndex(): Promise<LibraryFile | null>
  saveIndex(payload: LibraryFile): Promise<void>
  writeBook(name: string, blob: Blob): Promise<void>
  readBook(name: string): Promise<Blob | undefined>
  deleteBook(name: string): Promise<void>
}

/**
 * 以「文件目录」为主存储
 * 元信息与笔记合并写入 library.json，书籍原文写入 books/ 子目录
 */
class LibraryBackend implements StorageBackend {
  readonly persistent = true

  private readonly books = new Map<string, BookMeta>()
  private readonly notes = new Map<string, NoteRecord>()
  private readonly kv = new Map<string, unknown>()
  /** 已载入内存的书籍文件（按需从磁盘补齐） */
  private readonly loadedFiles = new Map<string, Blob>()
  /** 书籍 id → 磁盘文件名 */
  private readonly fileNames = new Map<string, string>()
  protected readonly ready: Promise<void>

  constructor(protected readonly store: FileStore) {
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    const library = await this.store.loadIndex()
    if (!library) return
    for (const book of library.books ?? []) this.books.set(book.id, book)
    for (const note of library.notes ?? []) this.notes.set(note.id, note)
    for (const item of library.kv ?? []) this.kv.set(item.key, item.value)
    for (const file of library.files ?? []) this.fileNames.set(file.id, file.name)
  }

  /** 落盘索引（只写元信息，体积小） */
  private async flush(): Promise<void> {
    await this.ready
    const payload: LibraryFile = {
      version: 1,
      savedAt: Date.now(),
      books: [...this.books.values()],
      notes: [...this.notes.values()],
      kv: [...this.kv.entries()].map(([key, value]) => ({ key, value })),
      files: [...this.fileNames.entries()].map(([id, name]) => ({ id, name })),
    }
    await this.store.saveIndex(payload)
  }

  /** 书籍在磁盘上的文件名 */
  private nameFor(id: string, format?: string): string {
    const known = this.fileNames.get(id)
    if (known) return known
    const meta = this.books.get(id)
    const ext = format ?? meta?.format ?? 'bin'
    return `${id}.${ext}`
  }

  async get<T>(store: string, key: string): Promise<T | undefined> {
    await this.ready
    if (store === STORE_BOOKS) return this.books.get(key) as T | undefined
    if (store === STORE_NOTES) return this.notes.get(key) as T | undefined
    if (store === STORE_KV) return this.kv.get(key) as T | undefined
    if (store === STORE_FILES) {
      const blob = await this.getBookFile(key)
      return blob ? ({ id: key, blob } as unknown as T) : undefined
    }
    return undefined
  }

  async getAll<T>(store: string): Promise<T[]> {
    await this.ready
    if (store === STORE_BOOKS) return [...this.books.values()] as T[]
    if (store === STORE_NOTES) return [...this.notes.values()] as T[]
    if (store === STORE_KV) return [...this.kv.entries()].map(([key, value]) => ({ key, value })) as T[]
    return []
  }

  async getAllByIndex<T>(store: string, index: string, value: string): Promise<T[]> {
    await this.ready
    if (store === STORE_NOTES) {
      return [...this.notes.values()].filter(
        (note) => (note as unknown as Record<string, unknown>)[index] === value,
      ) as T[]
    }
    return []
  }

  async put(store: string, value: unknown): Promise<void> {
    await this.ready
    if (store === STORE_BOOKS) {
      const meta = value as BookMeta
      this.books.set(meta.id, meta)
    } else if (store === STORE_NOTES) {
      const note = value as NoteRecord
      this.notes.set(note.id, note)
    } else if (store === STORE_KV) {
      const item = value as { key: string; value: unknown }
      this.kv.set(item.key, item.value)
    } else if (store === STORE_FILES) {
      const file = value as BookFile
      await this.putBookFile(file.id, file.blob)
      return
    }
    await this.flush()
  }

  async remove(store: string, key: string): Promise<void> {
    await this.ready
    if (store === STORE_BOOKS) {
      this.books.delete(key)
    } else if (store === STORE_NOTES) {
      this.notes.delete(key)
    } else if (store === STORE_KV) {
      this.kv.delete(key)
    } else if (store === STORE_FILES) {
      const name = this.fileNames.get(key) ?? this.nameFor(key)
      this.loadedFiles.delete(key)
      this.fileNames.delete(key)
      await this.store.deleteBook(name)
    }
    await this.flush()
  }

  async clear(store: string): Promise<void> {
    await this.ready
    if (store === STORE_BOOKS) this.books.clear()
    else if (store === STORE_NOTES) this.notes.clear()
    else if (store === STORE_KV) this.kv.clear()
    else if (store === STORE_FILES) {
      for (const name of this.fileNames.values()) await this.store.deleteBook(name)
      this.fileNames.clear()
      this.loadedFiles.clear()
    }
    await this.flush()
  }

  /** 写入书籍文件（同时保留在内存，避免重复读盘） */
  async putBookFile(id: string, blob: Blob, format?: string): Promise<void> {
    await this.ready
    const name = this.nameFor(id, format)
    this.fileNames.set(id, name)
    this.loadedFiles.set(id, blob)
    await this.store.writeBook(name, blob)
    await this.flush()
  }

  /** 读取书籍文件 */
  async getBookFile(id: string): Promise<Blob | undefined> {
    await this.ready
    const cached = this.loadedFiles.get(id)
    if (cached) return cached
    if (!this.fileNames.has(id)) return undefined
    const blob = await this.store.readBook(this.nameFor(id))
    if (blob) this.loadedFiles.set(id, blob)
    return blob ?? undefined
  }
}

/* ---- 实现一：用户选择的本地文件夹（File System Access API） ---- */

class DirFileStore implements FileStore {
  constructor(private readonly dir: DirHandleLike) {}

  async loadIndex(): Promise<LibraryFile | null> {
    await ensureDir(this.dir, BOOKS_DIR)
    return readJson<LibraryFile>(this.dir, LIBRARY_FILE)
  }

  async saveIndex(payload: LibraryFile): Promise<void> {
    await writeJson(this.dir, LIBRARY_FILE, payload)
  }

  async writeBook(name: string, blob: Blob): Promise<void> {
    const booksDir = await ensureDir(this.dir, BOOKS_DIR)
    await writeBlob(booksDir, name, blob)
  }

  async readBook(name: string): Promise<Blob | undefined> {
    const booksDir = await ensureDir(this.dir, BOOKS_DIR)
    const blob = await readBlob(booksDir, name)
    return blob ?? undefined
  }

  async deleteBook(name: string): Promise<void> {
    const booksDir = await ensureDir(this.dir, BOOKS_DIR)
    await removeFile(booksDir, name)
  }
}

/** 本地文件夹后端 */
class DirectoryBackend extends LibraryBackend {
  constructor(dir: DirHandleLike) {
    super(new DirFileStore(dir))
  }
}

/* ---- 实现二：原生 Sidecar（真正落在用户磁盘的绝对路径） ---- */

class SidecarFileStore implements FileStore {
  async loadIndex(): Promise<LibraryFile | null> {
    const index = await sidecar.readLibraryIndex()
    if (!index.exists || !index.json) return null
    try {
      return JSON.parse(index.json) as LibraryFile
    } catch {
      console.warn('[db] library.json 解析失败，按空书库处理')
      return null
    }
  }

  async saveIndex(payload: LibraryFile): Promise<void> {
    await sidecar.writeLibraryIndex(JSON.stringify(payload))
  }

  async writeBook(name: string, blob: Blob): Promise<void> {
    await sidecar.writeBookFile(name, blob)
  }

  async readBook(name: string): Promise<Blob | undefined> {
    return sidecar.readBookFile(name)
  }

  async deleteBook(name: string): Promise<void> {
    await sidecar.deleteBookFile(name)
  }
}

/** Sidecar 后端：数据落在用户磁盘上的书库目录 */
class SidecarBackend extends LibraryBackend {
  constructor() {
    super(new SidecarFileStore())
  }
}

/* ============ 存储模式管理 ============ */

export type StorageMode = 'auto' | 'sidecar' | 'directory' | 'memory'

export interface StorageInfo {
  /** 用户选择的模式 */
  mode: StorageMode
  /** 实际生效的后端 */
  active: 'sidecar' | 'indexeddb' | 'directory' | 'memory'
  /** 是否跨会话保留 */
  persistent: boolean
  /** 展示用位置说明 */
  location: string
  /** 目录模式下的目录名 */
  directoryName?: string
  /** 目录已选但权限失效，需要用户点击重新授权 */
  needsPermission?: boolean
  /** 是否支持选择本地文件夹 */
  canPickDirectory: boolean
  /** 目录选择不可用的原因（unsupported / sandboxed） */
  directoryBlocked?: 'unsupported' | 'sandboxed' | null
  /** 原生后端是否可用（可用时才能真正落盘到绝对路径） */
  hasSidecar: boolean
  /** 书库在磁盘上的绝对路径（仅 sidecar 后端） */
  rootPath?: string
  /** 插件数据目录（仅 sidecar 后端），用于说明默认位置 */
  dataDir?: string
  /** 书库是否处于默认位置（仅 sidecar 后端） */
  rootIsDefault?: boolean
  /** 书库目录里的书籍文件数量（仅 sidecar 后端） */
  bookFileCount?: number
}

/** 存储配置在 IndexedDB 中的键（只存指针，不存书库数据） */
const POINTER_KEY = 'settings:storage'

interface StoragePointer {
  mode: StorageMode
  handle?: DirHandleLike | null
}

let pointer: StoragePointer = { mode: 'auto' }
let activeBackend: StorageBackend | null = null
let activeKind: StorageInfo['active'] = 'memory'
let directoryNeedsPermission = false
/** 原生后端（Sidecar）是否可用 */
let sidecarReady = false
let initPromise: Promise<void> | null = null

/** 直接读写 IndexedDB 的 kv（仅用于存指针，避免依赖当前后端） */
async function pointerGet(): Promise<StoragePointer | null> {
  try {
    const db = await openIdb()
    return await new Promise<StoragePointer | null>((resolve) => {
      const tx = db.transaction(STORE_KV, 'readonly')
      const request = tx.objectStore(STORE_KV).get(POINTER_KEY)
      request.onsuccess = () => resolve((request.result as { value: StoragePointer } | undefined)?.value ?? null)
      request.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function pointerSet(value: StoragePointer): Promise<void> {
  try {
    const db = await openIdb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_KV, 'readwrite')
      tx.objectStore(STORE_KV).put({ key: POINTER_KEY, value })
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // 沙箱内无法持久化指针，仅本次会话有效
  }
}

/** 创建目录后端并确认可读 */
async function createDirectoryBackend(handle: DirHandleLike): Promise<StorageBackend> {
  const backend = new DirectoryBackend(handle)
  // 触发一次载入，权限失效会在这一步暴露
  await backend.getAll<BookMeta>(STORE_BOOKS)
  return backend
}

/** 初始化存储（应用启动时调用一次） */
export function initStorage(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    pointer = (await pointerGet()) ?? { mode: 'auto' }
    sidecarReady = await sidecar.probeSidecar()

    // 原生后端可用时优先：它是唯一能真正写进用户磁盘绝对路径的方案
    if (pointer.mode !== 'memory' && pointer.mode !== 'directory' && sidecarReady) {
      try {
        activeBackend = new SidecarBackend()
        activeKind = 'sidecar'
        await activeBackend.getAll<BookMeta>(STORE_BOOKS)
        return
      } catch (error) {
        console.warn('[db] 原生后端初始化失败，回退到浏览器存储', error)
        sidecarReady = false
      }
    }

    if (pointer.mode === 'directory' && pointer.handle) {
      let granted = false
      try {
        granted = (await pointer.handle.queryPermission?.({ mode: 'readwrite' })) === 'granted'
      } catch {
        granted = false
      }
      if (granted) {
        try {
          activeBackend = await createDirectoryBackend(pointer.handle)
          activeKind = 'directory'
          directoryNeedsPermission = false
          return
        } catch (error) {
          console.warn('[db] 目录后端初始化失败，回退到默认存储', error)
        }
      }
      // 权限待确认：先按默认后端工作，等用户点击重新授权
      directoryNeedsPermission = true
    }

    if (pointer.mode === 'memory') {
      activeBackend = new MemoryBackend()
      activeKind = 'memory'
      return
    }

    // auto / 目录权限待确认：优先 IndexedDB，失败降级内存
    try {
      const db = await openIdb()
      activeBackend = new IdbBackend(db)
      activeKind = 'indexeddb'
    } catch (error) {
      console.warn('[db] IndexedDB 不可用，已切换为内存存储（数据不跨会话保留）', error)
      activeBackend = new MemoryBackend()
      activeKind = 'memory'
    }
  })()
  return initPromise
}

/** 取得当前后端 */
async function backend(): Promise<StorageBackend> {
  await initStorage()
  if (!activeBackend) {
    activeBackend = new MemoryBackend()
    activeKind = 'memory'
  }
  return activeBackend
}

/** 读取当前存储信息 */
export async function getStorageInfo(): Promise<StorageInfo> {
  await initStorage()
  const info: StorageInfo = {
    mode: pointer.mode,
    active: activeKind,
    persistent: activeKind !== 'memory',
    location: '浏览器数据库（IndexedDB）',
    directoryName: pointer.handle?.name,
    needsPermission: directoryNeedsPermission,
    directoryBlocked: directoryBlockReason(),
    canPickDirectory: directoryBlockReason() === null,
    hasSidecar: sidecarReady,
  }
  if (activeKind === 'directory') info.location = `本地文件夹：${pointer.handle?.name ?? '已选目录'}`
  else if (activeKind === 'memory') info.location = '内存（仅本次会话）'
  else if (activeKind === 'sidecar') {
    info.location = '磁盘目录（原生后端）'
    try {
      const detail = await sidecar.describeStorage()
      info.rootPath = detail.root
      info.dataDir = detail.dataDir
      info.rootIsDefault = detail.isDefault
      info.bookFileCount = detail.bookCount ?? 0
    } catch {
      /* 拿不到细节时保留默认文案 */
    }
  }
  return info
}

/** 书库是否由原生后端落盘（决定界面上能否改路径） */
export async function storageUsesSidecar(): Promise<boolean> {
  await initStorage()
  return activeKind === 'sidecar'
}

/** 当前存储是否跨会话保留（保留旧接口语义） */
export async function storagePersistent(): Promise<boolean> {
  return (await getStorageInfo()).persistent
}

/* ============ 模式切换与迁移 ============ */

type Snapshot = {
  books: BookMeta[]
  notes: NoteRecord[]
  kv: Array<{ key: string; value: unknown }>
  files: Array<{ id: string; blob: Blob }>
}

/** 读出某个后端的全部数据（迁移用） */
async function snapshot(source: StorageBackend): Promise<Snapshot> {
  const books = await source.getAll<BookMeta>(STORE_BOOKS)
  const notes = await source.getAll<NoteRecord>(STORE_NOTES)
  const kv = await source.getAll<{ key: string; value: unknown }>(STORE_KV)
  const files: Array<{ id: string; blob: Blob }> = []
  for (const book of books) {
    const record = await source.get<BookFile>(STORE_FILES, book.id)
    if (record?.blob) files.push({ id: book.id, blob: record.blob })
  }
  return { books, notes, kv, files }
}

/** 把数据写入目标后端（跳过指针键，避免覆盖存储配置） */
async function restore(target: StorageBackend, data: Snapshot): Promise<{ books: number; notes: number }> {
  for (const book of data.books) await target.put(STORE_BOOKS, book)
  for (const note of data.notes) await target.put(STORE_NOTES, note)
  for (const item of data.kv) {
    if (item.key === POINTER_KEY) continue
    await target.put(STORE_KV, item)
  }
  for (const file of data.files) {
    await target.put(STORE_FILES, { id: file.id, blob: file.blob } satisfies BookFile)
  }
  return { books: data.books.length, notes: data.notes.length }
}

/**
 * 切换存储位置
 * @param mode 目标模式；'directory' 需配合 handle
 * @param handle 用户选择的目录
 * @param migrate 是否把当前数据迁移到新位置
 */
export async function switchStorage(
  mode: StorageMode,
  handle: DirHandleLike | null,
  migrate = true,
): Promise<{ books: number; notes: number }> {
  await initStorage()
  const previous = activeBackend
  let next: StorageBackend

  if (mode === 'directory') {
    if (!handle) throw new Error('请选择本地文件夹')
    next = await createDirectoryBackend(handle)
  } else if (mode === 'memory') {
    next = new MemoryBackend()
  } else if (mode === 'sidecar') {
    if (!sidecarReady && !(await sidecar.probeSidecar())) throw new Error('原生后端不可用')
    sidecarReady = true
    next = new SidecarBackend()
  } else {
    // auto：原生后端优先，其次 IndexedDB，最后内存
    if (sidecarReady) {
      next = new SidecarBackend()
    } else {
      try {
        next = new IdbBackend(await openIdb())
      } catch (error) {
        console.warn('[db] IndexedDB 不可用，改为内存存储', error)
        next = new MemoryBackend()
      }
    }
  }

  let result = { books: 0, notes: 0 }
  if (migrate && previous && previous !== next) {
    const data = await snapshot(previous)
    result = await restore(next, data)
  }

  activeBackend = next
  if (mode === 'directory') activeKind = 'directory'
  else if (next instanceof SidecarBackend) activeKind = 'sidecar'
  else activeKind = next instanceof IdbBackend ? 'indexeddb' : 'memory'
  directoryNeedsPermission = false
  pointer = { mode, handle: mode === 'directory' ? handle : null }
  await pointerSet(pointer)
  return result
}

/**
 * 修改原生后端的书库目录
 *
 * 分两步：先让 Sidecar 建目录并把旧数据搬过去（Go 侧做文件级复制），
 * 再重建后端实例、从新目录读取索引。这里刻意不做 switchStorage 的快照迁移，
 * 否则会用旧书库覆盖目标目录里已有的书库。
 */
export async function changeSidecarRoot(path: string): Promise<{ root: string; isDefault: boolean }> {
  await initStorage()
  const detail = await sidecar.setStorageRoot(path)
  await switchStorage('sidecar', null, false)
  return { root: detail.root, isDefault: detail.isDefault }
}

/** 恢复默认书库目录 */
export async function resetSidecarRoot(): Promise<{ root: string; isDefault: boolean }> {
  await initStorage()
  const detail = await sidecar.resetStorageRoot()
  await switchStorage('sidecar', null, false)
  return { root: detail.root, isDefault: detail.isDefault }
}

/** 对已选目录重新授权（浏览器跨会话收回权限后调用） */
export async function reconnectDirectory(): Promise<boolean> {
  await initStorage()
  const handle = pointer.handle
  if (!handle?.requestPermission) return false
  const state = await handle.requestPermission({ mode: 'readwrite' })
  if (state !== 'granted') return false
  activeBackend = await createDirectoryBackend(handle)
  activeKind = 'directory'
  directoryNeedsPermission = false
  return true
}

/* ============ 书库数据 API ============ */

/** 读取全部书籍元信息 */
export async function listBooks(): Promise<BookMeta[]> {
  const db = await backend()
  return db.getAll<BookMeta>(STORE_BOOKS)
}

/** 保存（新增或覆盖）书籍元信息 */
export async function putBook(meta: BookMeta): Promise<void> {
  const db = await backend()
  await db.put(STORE_BOOKS, meta)
}

/** 读取单本书元信息 */
export async function getBook(id: string): Promise<BookMeta | undefined> {
  const db = await backend()
  return db.get<BookMeta>(STORE_BOOKS, id)
}

/** 删除书籍及其文件、笔记 */
export async function deleteBookCascade(id: string): Promise<void> {
  const db = await backend()
  await db.remove(STORE_BOOKS, id)
  await db.remove(STORE_FILES, id)
  const notes = await listNotes(id)
  await Promise.all(notes.map((note) => deleteNote(note.id)))
}

/** 保存书籍文件正文 */
export async function putBookFile(id: string, blob: Blob, format?: string): Promise<void> {
  const db = await backend()
  if (db instanceof LibraryBackend) {
    await db.putBookFile(id, blob, format)
    return
  }
  await db.put(STORE_FILES, { id, blob } satisfies BookFile)
}

/** 读取书籍文件正文 */
export async function getBookFile(id: string): Promise<Blob | undefined> {
  const db = await backend()
  const record = await db.get<BookFile>(STORE_FILES, id)
  return record?.blob
}

/** 读取某本书的全部笔记 */
export async function listNotes(bookId: string): Promise<NoteRecord[]> {
  const db = await backend()
  return db.getAllByIndex<NoteRecord>(STORE_NOTES, 'bookId', bookId)
}

/** 读取全部笔记（备份用） */
export async function listAllNotes(): Promise<NoteRecord[]> {
  const db = await backend()
  return db.getAll<NoteRecord>(STORE_NOTES)
}

/** 新增或更新笔记 */
export async function putNote(note: NoteRecord): Promise<void> {
  const db = await backend()
  await db.put(STORE_NOTES, note)
}

/** 删除笔记 */
export async function deleteNote(id: string): Promise<void> {
  const db = await backend()
  await db.remove(STORE_NOTES, id)
}

/** 写入缓存值 */
export async function setCache<T>(key: string, value: T): Promise<void> {
  const db = await backend()
  await db.put(STORE_KV, { key, value })
}

/** 读取缓存值 */
export async function getCache<T>(key: string): Promise<T | undefined> {
  const db = await backend()
  const record = await db.get<{ key: string; value: T }>(STORE_KV, key)
  return record?.value
}

/** 清空全部数据（仅在用户二次确认后调用） */
export async function clearAll(): Promise<void> {
  const db = await backend()
  await db.clear(STORE_BOOKS)
  await db.clear(STORE_FILES)
  await db.clear(STORE_NOTES)
  await db.clear(STORE_KV)
}
