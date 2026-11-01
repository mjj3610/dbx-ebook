/**
 * 备份与恢复
 * 两种形态：
 * 1. 仅数据（.dbxebook JSON）：书单、进度、笔记、阅读设置，体积极小
 * 2. 含书籍文件（ZIP 包）：额外附带原始书籍文件，可在新设备完整还原
 * 注意：翻译密钥 / WebDAV 密码等敏感信息不写入备份包
 */
import JSZip from 'jszip'
import { BACKUP_EXT, BACKUP_VERSION } from './constants'
import { getBookFile, listAllNotes, listBooks, putBook, putBookFile, putNote } from './db'
import { settings } from './settings'
import type { BackupPayload, BookMeta, NoteRecord } from './types'
import { blobToDataUrl, formatBytes } from './utils'
import { loadZip } from './parsers/zipUtils'

/** 导出结果 */
export interface ExportResult {
  blob: Blob
  filename: string
  bookCount: number
  noteCount: number
  size: number
}

/** 生成带时间戳的文件名 */
function backupFilename(prefix: string, ext: string): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${prefix}-${stamp}${ext}`
}

/** 构造备份数据体 */
async function buildPayload(): Promise<BackupPayload> {
  const books = await listBooks()
  const notes = await listAllNotes()
  // 去掉 Blob 字段，保证可 JSON 序列化
  const metaList = books as BackupPayload['books']
  return {
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    books: metaList,
    notes,
    settings: {
      reader: JSON.parse(JSON.stringify(settings.reader)),
      tts: JSON.parse(JSON.stringify(settings.tts)),
    },
  }
}

/**
 * 导出备份
 * @param includeFiles 是否包含书籍文件
 */
export async function exportBackup(includeFiles: boolean): Promise<ExportResult> {
  const payload = await buildPayload()
  const bookCount = payload.books.length
  const noteCount = payload.notes.length

  if (!includeFiles) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    return {
      blob,
      filename: backupFilename('dbx-ebook-data', BACKUP_EXT),
      bookCount,
      noteCount,
      size: blob.size,
    }
  }

  const zip = new JSZip()
  zip.file('backup.json', JSON.stringify(payload, null, 2))
  for (const book of payload.books) {
    const blob = await getBookFile(book.id)
    if (!blob) continue
    zip.file(`files/${book.id}.bin`, blob)
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return {
    blob,
    filename: backupFilename('dbx-ebook-full', '.zip'),
    bookCount,
    noteCount,
    size: blob.size,
  }
}

/** 导入结果 */
export interface ImportBackupResult {
  booksAdded: number
  booksSkipped: number
  notesAdded: number
}

/**
 * 导入备份
 * @param file 备份文件（.dbxebook 或 .zip）
 * @param options.overwriteNotes 是否用备份覆盖同 ID 笔记
 */
export async function importBackup(
  file: File,
  options: { overwriteNotes?: boolean } = {},
): Promise<ImportBackupResult> {
  let payload: BackupPayload
  const isZip = /\.zip$/i.test(file.name) || (await isZipFile(file))

  if (isZip) {
    const zip = await loadZip(await file.arrayBuffer())
    const jsonEntry = zip.file('backup.json')
    if (!jsonEntry) throw new Error('备份包缺少 backup.json，可能不是本应用导出的文件')
    payload = JSON.parse(await jsonEntry.async('string')) as BackupPayload
    // 还原书籍文件
    for (const book of payload.books) {
      const entry = zip.file(`files/${book.id}.bin`)
      if (!entry) continue
      const buffer = await entry.async('arraybuffer')
      const type = book.format === 'pdf' ? 'application/pdf' : 'application/octet-stream'
      await putBookFile(book.id, new Blob([buffer], { type }))
    }
  } else {
    const text = await file.text()
    payload = JSON.parse(text) as BackupPayload
  }

  if (!payload || payload.version !== BACKUP_VERSION) {
    throw new Error('备份文件版本不兼容，请使用相同版本的应用导入')
  }

  const existing = await listBooks()
  const existingIds = new Set(existing.map((book) => book.id))
  const existingHashes = new Map(existing.map((book) => [book.hash, book.id]))
  let booksAdded = 0
  let booksSkipped = 0

  for (const book of payload.books) {
    // 同内容已存在时跳过，避免重复占空间
    if (existingIds.has(book.id) || existingHashes.has(book.hash)) {
      booksSkipped += 1
      continue
    }
    await putBook(book as BookMeta)
    booksAdded += 1
  }

  const existingNotes = new Set((await listAllNotes()).map((note) => note.id))
  let notesAdded = 0
  for (const note of payload.notes as NoteRecord[]) {
    if (existingNotes.has(note.id) && !options.overwriteNotes) continue
    await putNote(note)
    notesAdded += 1
  }

  // 阅读设置（不含敏感项）按需覆盖；沙箱内 localStorage 可能不可用，写入失败不影响书籍与笔记恢复
  try {
    if (payload.settings?.reader) {
      localStorage.setItem('dbx-ebook:reader-settings', JSON.stringify(payload.settings.reader))
    }
    if (payload.settings?.tts) {
      localStorage.setItem('dbx-ebook:tts-settings', JSON.stringify(payload.settings.tts))
    }
  } catch (error) {
    console.warn('[backup] 设置未能写入本地存储', error)
  }

  return { booksAdded, booksSkipped, notesAdded }
}

/** 通过文件头判断是否为 ZIP */
async function isZipFile(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // 延迟回收，避免部分浏览器下载中断
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/**
 * 导出某本书的笔记为 Markdown
 * @param bookTitle 书名
 * @param notes 笔记列表
 * @param chapterTitles 章节标题（索引对齐）
 */
export function notesToMarkdown(
  bookTitle: string,
  notes: NoteRecord[],
  chapterTitles: string[],
): Blob {
  const lines: string[] = [`# 《${bookTitle}》读书笔记`, '', `> 导出时间：${new Date().toLocaleString('zh-CN')}`, '']
  const sorted = [...notes].sort((a, b) => a.chapterIndex - b.chapterIndex || a.start - b.start)
  let lastChapter = -1
  for (const note of sorted) {
    if (note.chapterIndex !== lastChapter) {
      lastChapter = note.chapterIndex
      lines.push('', `## ${chapterTitles[note.chapterIndex] ?? `第 ${note.chapterIndex + 1} 章`}`, '')
    }
    lines.push(`- ${note.text.replace(/\n/g, ' ')}`)
    if (note.comment) lines.push(`  - 批注：${note.comment}`)
  }
  lines.push('', `共 ${sorted.length} 条笔记`)
  return new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
}

/** 备份包可读体积描述 */
export function describeBackup(blob: Blob): string {
  return formatBytes(blob.size)
}

/** 将封面 dataURL 重新读出（用于展示，占位实现保持一致接口） */
export async function coverPreview(blob: Blob): Promise<string> {
  return blobToDataUrl(blob)
}
