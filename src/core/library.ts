/**
 * 书架业务层：导入、打开、封面处理、内存回收
 */
import { COVER_MAX_EDGE, MAX_BOOK_SIZE } from './constants'
import { deleteBookCascade, getBook, getBookFile, listBooks, putBook, putBookFile } from './db'
import { parseBook, SUPPORTED_EXTENSIONS } from './parsers'
import type { BookDoc, BookFormat, BookMeta, ReadingProgress } from './types'
import { formatBytes, hashBlob, titleFromFilename, uid } from './utils'

/** 导入结果 */
export interface ImportResult {
  added: BookMeta[]
  skipped: Array<{ name: string; reason: string }>
  failed: Array<{ name: string; reason: string }>
}

/** 已解析文档的内存缓存（同一本书反复打开时避免重复解析） */
const docCache = new Map<string, BookDoc>()
/** 缓存上限，超出后按插入顺序淘汰，控制内存占用 */
const DOC_CACHE_LIMIT = 2

/** 生成可接受的文件选择 accept 属性 */
export function acceptAttribute(): string {
  return SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(',')
}

/** 打开书籍：优先命中内存缓存 */
export async function openBook(id: string): Promise<BookDoc> {
  const cached = docCache.get(id)
  if (cached) return cached
  const meta = await getBook(id)
  if (!meta) throw new Error('书籍不存在，可能已被删除')
  const blob = await getBookFile(id)
  if (!blob) throw new Error('书籍文件丢失，请重新导入')
  const file = new File([blob], `${meta.title}.${meta.format}`, { type: blob.type })
  const doc = await parseBook(file)
  // 解析结果可能缺少元信息，用记录补齐
  if (!doc.title) doc.title = meta.title
  cacheDoc(id, doc)
  return doc
}

/** 写入缓存并执行淘汰 */
function cacheDoc(id: string, doc: BookDoc): void {
  docCache.delete(id)
  docCache.set(id, doc)
  while (docCache.size > DOC_CACHE_LIMIT) {
    const oldestKey = docCache.keys().next().value
    if (!oldestKey) break
    const stale = docCache.get(oldestKey)
    if (stale) releaseDoc(stale)
    docCache.delete(oldestKey)
  }
}

/** 释放文档占用的 blob URL，避免内存泄漏 */
export function releaseDoc(doc: BookDoc): void {
  try {
    doc.pages?.forEach((page) => URL.revokeObjectURL(page.url))
    doc.chapters.forEach((chapter) => {
      const urls = chapter.html.match(/blob:[^"')]+/g)
      urls?.forEach((url) => URL.revokeObjectURL(url))
    })
    if (doc.cover?.startsWith('blob:')) URL.revokeObjectURL(doc.cover)
  } catch {
    /* 忽略回收异常 */
  }
}

/** 从缓存中移除并释放 */
export function evictBook(id: string): void {
  const doc = docCache.get(id)
  if (doc) releaseDoc(doc)
  docCache.delete(id)
}

/**
 * 封面归一化：把任意图片来源压缩为 ≤COVER_MAX_EDGE 的 JPEG dataURL
 * 目的：控制 IndexedDB 体积，并保证重启后仍可显示
 */
export async function normalizeCover(source: string): Promise<string> {
  if (!source) return ''
  if (source.startsWith('data:') && source.length < 40_000) return source
  try {
    const image = await loadImage(source)
    const scale = Math.min(COVER_MAX_EDGE / image.width, COVER_MAX_EDGE / image.height, 1)
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return ''
    context.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.82)
  } catch {
    return ''
  }
}

/** 加载图片元素 */
function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('封面加载失败'))
    image.src = source
  })
}

/**
 * 批量导入文件
 * @param files 用户选择的文件
 * @param onProgress 进度回调（当前序号, 总数, 文件名）
 */
export async function importFiles(
  files: File[],
  onProgress?: (current: number, total: number, name: string) => void,
): Promise<ImportResult> {
  const existing = await listBooks()
  const knownHashes = new Set(existing.map((book) => book.hash))
  const result: ImportResult = { added: [], skipped: [], failed: [] }

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    onProgress?.(i + 1, files.length, file.name)

    if (file.size === 0) {
      result.failed.push({ name: file.name, reason: '文件为空' })
      continue
    }
    if (file.size > MAX_BOOK_SIZE) {
      result.failed.push({
        name: file.name,
        reason: `文件超过 ${formatBytes(MAX_BOOK_SIZE)}，请拆分后再导入`,
      })
      continue
    }

    try {
      const hash = await hashBlob(file)
      if (knownHashes.has(hash)) {
        result.skipped.push({ name: file.name, reason: '书架中已存在同名内容' })
        continue
      }
      const doc = await parseBook(file)
      const cover = await normalizeCover(doc.cover ?? doc.pages?.[0]?.url ?? '')
      const id = uid('book')
      const now = Date.now()
      const format: BookFormat = doc.format
      const unitCount = doc.kind === 'flow' ? doc.chapters.length : doc.kind === 'pdf' ? doc.pageCount ?? 1 : doc.pages?.length ?? 0

      const meta: BookMeta = {
        id,
        title: doc.title || titleFromFilename(file.name),
        author: doc.author ?? '',
        format,
        kind: doc.kind,
        size: file.size,
        hash,
        cover,
        unitCount,
        addedAt: now,
        lastReadAt: 0,
        progress: { chapterIndex: 0, page: 0, percent: 0, bookPercent: 0, updatedAt: 0 },
      }

      // 先写元信息：磁盘文件名要按 format 生成（book_xxx.txt 而不是 .bin），
      // 顺序反了就只能退化成 .bin，用户在用资源管理器查看时很不直观
      await putBook(meta)
      await putBookFile(id, file, meta.format)
      // 解析结果直接进入缓存，用户点开即可秒开；直接复用同一份文档对象，避免提前回收 blob URL
      doc.title = meta.title
      doc.author = meta.author
      doc.cover = cover
      cacheDoc(id, doc)
      knownHashes.add(hash)
      result.added.push(meta)
    } catch (error) {
      const raw = error instanceof Error ? error.message : '未知解析错误'
      // 浏览器在文件被外部回收时会抛出 NotReadableError，转为可执行提示
      const reason = /could not be read|NotReadableError/i.test(raw)
        ? '无法读取文件内容，请重新选择该文件'
        : raw
      result.failed.push({ name: file.name, reason })
    }
  }

  return result
}

/** 删除书籍（含文件与笔记） */
export async function removeBook(id: string): Promise<void> {
  evictBook(id)
  await deleteBookCascade(id)
}

/** 更新阅读进度（内部读取最新元信息，避免覆盖并发写入的字段） */
export async function saveProgress(id: string, progress: Partial<ReadingProgress>): Promise<void> {
  const meta = await getBook(id)
  if (!meta) return
  const now = Date.now()
  const next: BookMeta = {
    ...meta,
    lastReadAt: now,
    progress: {
      ...meta.progress,
      ...progress,
      bookPercent: Math.min(Math.max(progress.bookPercent ?? meta.progress.bookPercent, 0), 1),
      updatedAt: now,
    },
  }
  await putBook(next)
}
