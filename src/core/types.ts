/**
 * 全局领域类型定义
 * 说明：所有解析器统一输出 BookDoc，阅读器只面向该模型，新增格式无需改动阅读器。
 */

/** 支持的电子书格式（用于格式识别与展示） */
export type BookFormat =
  | 'epub'
  | 'pdf'
  | 'txt'
  | 'mobi'
  | 'azw'
  | 'azw3'
  | 'prc'
  | 'fb2'
  | 'fbz'
  | 'cbz'
  | 'cbt'
  | 'cbr'
  | 'cb7'
  | 'html'
  | 'md'
  | 'rtf'
  | 'docx'
  | 'odt'
  | 'doc'
  | 'unknown'

/** 文档类型：文字流 / PDF / 漫画图集 */
export type BookKind = 'flow' | 'pdf' | 'comic'

/** 章节（flow 类型文档的最小阅读单元） */
export interface Chapter {
  /** 章节唯一标识（书内稳定，用于笔记锚定） */
  id: string
  /** 章节标题 */
  title: string
  /** 章节 HTML 片段（已净化，不含脚本） */
  html: string
  /** 纯文本内容（用于听书、翻译、全文检索） */
  text: string
}

/** 目录项 */
export interface TocItem {
  /** 标题 */
  title: string
  /** 层级，从 0 开始 */
  level: number
  /** 目标章节索引 */
  chapterIndex: number
}

/** 漫画页 */
export interface ComicPage {
  /** 页名（用于自然排序） */
  name: string
  /** 可访问的图片 URL（blob: 或 data:） */
  url: string
}

/** 解析后的文档模型 */
export interface BookDoc {
  kind: BookKind
  format: BookFormat
  title: string
  author?: string
  /** 语言标签，如 zh-CN */
  language?: string
  /** 封面 URL（data: / blob:） */
  cover?: string
  /** flow 类型章节列表 */
  chapters: Chapter[]
  /** comic 类型页面列表 */
  pages?: ComicPage[]
  /** pdf 类型原始数据 */
  pdfData?: ArrayBuffer
  /** pdf 页数 */
  pageCount?: number
  /** 目录（flow 类型） */
  toc?: TocItem[]
  /** 书名样式（EPUB 内联 CSS，注入 Shadow DOM 使用） */
  cssText?: string
  /** 解析告警（例如压缩算法不支持） */
  warnings?: string[]
}

/** 阅读进度 */
export interface ReadingProgress {
  /** 当前章节索引（flow / comic / pdf 均复用为页索引） */
  chapterIndex: number
  /** 章节内页码（分页模式） */
  page: number
  /** 章节内百分比 0~1（滚动模式） */
  percent: number
  /** 全书进度 0~1 */
  bookPercent: number
  /** 更新时间戳 */
  updatedAt: number
}

/** 书架书籍记录（IndexedDB 持久化） */
export interface BookRecord {
  id: string
  title: string
  author: string
  format: BookFormat
  kind: BookKind
  /** 文件大小（字节） */
  size: number
  /** 文件内容指纹，用于导入去重 */
  hash: string
  /** 小尺寸封面 dataURL */
  cover?: string
  /** 章节数 / 页数 */
  unitCount: number
  addedAt: number
  lastReadAt: number
  progress: ReadingProgress
  /** 原始文件 */
  file: Blob
}

/** 书籍元信息（不含文件正文，书架列表只读取该结构以节省内存） */
export type BookMeta = Omit<BookRecord, 'file'>

/** 书籍文件载体 */
export interface BookFile {
  id: string
  blob: Blob
}

/** 高亮笔记 */
export interface NoteRecord {
  id: string
  bookId: string
  chapterIndex: number
  /** 章节内字符起止偏移（基于章节纯文本） */
  start: number
  end: number
  /** 命中文本 */
  text: string
  /** 批注内容 */
  comment: string
  /** 高亮色 */
  color: NoteColor
  createdAt: number
  updatedAt: number
}

/** 高亮颜色 */
export type NoteColor = 'yellow' | 'green' | 'blue' | 'pink'

/** 阅读模式 */
export type ReadingMode = 'paged' | 'double' | 'scroll'

/** 阅读设置 */
export interface ReaderSettings {
  mode: ReadingMode
  /** 字号 px */
  fontSize: number
  /** 行距倍数 */
  lineHeight: number
  /** 字体族 key */
  fontFamily: 'serif' | 'sans' | 'kai'
  /** 页边距 px */
  padding: number
  /** 主题 key */
  theme: 'light' | 'sepia' | 'green' | 'dark'
  /** 语言 */
  locale: 'zh-CN' | 'en'
}

/** 听书设置 */
export interface TtsSettings {
  /** 语速 0.5~2 */
  rate: number
  /** 音调 0.5~2 */
  pitch: number
  /** 音量 0~1 */
  volume: number
  /** 音色 URI，空表示自动选择 */
  voiceURI: string
}

/** 翻译服务商 */
export type TranslateProvider = 'openai' | 'libre'

/** 翻译设置 */
export interface TranslateSettings {
  provider: TranslateProvider
  /** OpenAI 兼容接口地址，如 https://api.openai.com/v1 */
  baseUrl: string
  apiKey: string
  model: string
  /** LibreTranslate 服务地址 */
  libreUrl: string
  /** 目标语言 */
  targetLang: string
}

/** WebDAV 备份设置 */
export interface WebdavSettings {
  url: string
  username: string
  password: string
  /** 远端备份文件名 */
  filename: string
  /** 是否自动同步 */
  autoSync: boolean
}

/** 备份包结构 */
export interface BackupPayload {
  version: number
  createdAt: number
  books: Array<Omit<BookRecord, 'file'>>
  notes: NoteRecord[]
  settings: {
    reader: ReaderSettings
    tts: TtsSettings
  }
}
