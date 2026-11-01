/**
 * TXT 解析：自动识别编码 → 章节切分
 */
import type { BookDoc } from '../types'
import { splitChapters } from '../chapterize'
import { decodeText, titleFromFilename } from '../utils'

export async function parseTxt(file: File): Promise<BookDoc> {
  const text = await decodeText(file)
  const title = titleFromFilename(file.name)
  const chapters = splitChapters(text, title)
  return {
    kind: 'flow',
    format: 'txt',
    title,
    chapters,
    toc: chapters.map((chapter, index) => ({ title: chapter.title, level: 0, chapterIndex: index })),
  }
}
