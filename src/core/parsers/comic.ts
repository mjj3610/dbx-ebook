/**
 * 漫画书解析：CBZ（ZIP 打包图片）/ CBT（TAR 打包图片）
 * 按文件名自然排序（img2 在 img10 之前），输出图片页列表
 */
import JSZip from 'jszip'
import type { BookDoc, ComicPage } from '../types'
import { naturalCompare, titleFromFilename } from '../utils'
import { indexZip, isImagePath, loadZip, zipEntry, zipList } from './zipUtils'

/**
 * 解析 TAR 归档（CBT 使用）
 * @param buffer 归档字节
 * @returns 文件名 → 字节切片
 */
function readTar(buffer: ArrayBuffer): Map<string, Uint8Array> {
  const bytes = new Uint8Array(buffer)
  const files = new Map<string, Uint8Array>()
  let offset = 0
  const decoder = new TextDecoder('utf-8')

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    // 全零区块表示归档结束
    if (header.every((byte) => byte === 0)) break

    const readString = (start: number, length: number): string => {
      const slice = header.subarray(start, start + length)
      const end = slice.indexOf(0)
      return decoder.decode(end >= 0 ? slice.subarray(0, end) : slice).trim()
    }

    let name = readString(0, 100)
    const prefix = readString(345, 155)
    if (prefix) name = `${prefix}/${name}`
    const sizeText = readString(124, 12).replace(/\0/g, '').trim()
    const size = parseInt(sizeText, 8) || 0
    const typeFlag = String.fromCharCode(header[156] || 0x30)

    const dataStart = offset + 512
    if ((typeFlag === '0' || typeFlag === '\0' || typeFlag === '5') && size > 0 && dataStart + size <= bytes.length) {
      files.set(name, bytes.slice(dataStart, dataStart + size))
    }
    // 数据区按 512 字节对齐
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

export async function parseComic(file: File, format: 'cbz' | 'cbt'): Promise<BookDoc> {
  const pages: ComicPage[] = []

  if (format === 'cbz') {
    const zip = await loadZip(await file.arrayBuffer())
    const zipper = indexZip(zip)
    const names = zipList(zipper, (path) => isImagePath(path)).sort(naturalCompare)
    for (const name of names) {
      const entry = zipEntry(zipper, name)
      if (!entry) continue
      const buffer = await entry.async('arraybuffer')
      const blob = new Blob([buffer], { type: guessImageMime(name) })
      pages.push({ name: name.split('/').pop() ?? name, url: URL.createObjectURL(blob) })
    }
  } else {
    const files = readTar(await file.arrayBuffer())
    const names = Array.from(files.keys())
      .filter((name) => isImagePath(name))
      .sort(naturalCompare)
    for (const name of names) {
      const data = files.get(name)
      if (!data) continue
      const blob = new Blob([toArrayBuffer(data)], { type: guessImageMime(name) })
      pages.push({ name: name.split('/').pop() ?? name, url: URL.createObjectURL(blob) })
    }
  }

  if (!pages.length) {
    throw new Error('漫画包内未找到图片：请确认压缩包中包含 jpg / png / webp 图片')
  }

  return {
    kind: 'comic',
    format,
    title: titleFromFilename(file.name),
    chapters: [],
    pages,
    cover: pages[0]?.url,
    toc: [],
  }
}

/** 提取独立的 ArrayBuffer 视图（避免 SharedArrayBuffer 类型不兼容） */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

/** 图片 MIME 推断 */
function guessImageMime(path: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase()
  const table: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
  }
  return table[ext] ?? 'image/jpeg'
}
