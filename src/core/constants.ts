/**
 * 常量配置：禁止在业务代码中出现魔法值
 */
import type {
  BookFormat,
  NoteColor,
  ReaderSettings,
  TranslateSettings,
  TtsSettings,
  WebdavSettings,
} from './types'

/** IndexedDB 数据库名与版本 */
export const DB_NAME = 'dbx-ebook'
export const DB_VERSION = 1

/** 对象仓库名 */
export const STORE_BOOKS = 'books'
export const STORE_NOTES = 'notes'
export const STORE_KV = 'kv'

/** 备份包版本号 */
export const BACKUP_VERSION = 1
/** 备份包扩展名 */
export const BACKUP_EXT = '.dbxebook'

/** 单本书允许的最大体积（字节），防止误导入超大文件导致内存溢出 */
export const MAX_BOOK_SIZE = 512 * 1024 * 1024
/** 封面缩略图最大边长 */
export const COVER_MAX_EDGE = 320

/** 字号可调范围 */
export const FONT_SIZE_MIN = 14
export const FONT_SIZE_MAX = 34
export const FONT_SIZE_STEP = 1
/** 页边距范围 */
export const PADDING_MIN = 16
export const PADDING_MAX = 120
export const PADDING_STEP = 8

/** 分页列间距（双页模式中间缝隙） */
export const COLUMN_GAP = 56
/** 双页模式要求的最小容器宽度，低于该值自动降级为单页 */
export const DOUBLE_PAGE_MIN_WIDTH = 900
/** 单页最大正文宽度，避免宽屏下单行过长影响阅读 */
export const READING_COLUMN_MAX = 820

/** 键盘翻页节流间隔（毫秒） */
export const PAGE_TURN_THROTTLE = 160
/** 滚动模式章节懒加载预取距离（像素） */
export const SCROLL_PREFETCH_PX = 1200
/** 阅读进度保存节流间隔（毫秒） */
export const PROGRESS_SAVE_DELAY = 600

/** 高亮颜色配置 */
export const NOTE_COLORS: Record<NoteColor, { bg: string; border: string; label: string }> = {
  yellow: { bg: 'rgba(255, 214, 102, .45)', border: '#f0b429', label: '黄色' },
  green: { bg: 'rgba(120, 214, 141, .40)', border: '#38a169', label: '绿色' },
  blue: { bg: 'rgba(116, 178, 255, .40)', border: '#3182ce', label: '蓝色' },
  pink: { bg: 'rgba(255, 150, 200, .38)', border: '#d53f8c', label: '粉色' },
}

/** 阅读主题配置 */
export const THEMES: Record<
  ReaderSettings['theme'],
  { bg: string; paper: string; text: string; sub: string; border: string; label: string }
> = {
  light: { bg: '#eef0f4', paper: '#ffffff', text: '#1f2329', sub: '#8a9099', border: '#e6e8ec', label: '白色' },
  sepia: { bg: '#e8dfcd', paper: '#f6efe1', text: '#4a3f31', sub: '#9c8f7b', border: '#e0d5c0', label: '米黄' },
  green: { bg: '#dfe8dd', paper: '#e9f0e4', text: '#2f3d2f', sub: '#7d8f7b', border: '#d4e0cd', label: '护眼' },
  dark: { bg: '#16181c', paper: '#1e2126', text: '#c9cdd4', sub: '#7a8089', border: '#2b2f36', label: '夜间' },
}

/** 字体族配置 */
export const FONT_FAMILIES: Record<ReaderSettings['fontFamily'], { label: string; css: string }> = {
  serif: {
    label: '衬线',
    css: '"Source Han Serif SC", "Noto Serif SC", "Songti SC", SimSun, Georgia, serif',
  },
  sans: {
    label: '黑体',
    css: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif',
  },
  kai: { label: '楷体', css: '"Kaiti SC", KaiTi, STKaiti, "Noto Serif SC", serif' },
}

/** 支持导入的文件扩展名 → 格式 */
export const FORMAT_BY_EXT: Record<string, BookFormat> = {
  epub: 'epub',
  pdf: 'pdf',
  txt: 'txt',
  text: 'txt',
  mobi: 'mobi',
  azw: 'azw',
  azw3: 'azw3',
  prc: 'prc',
  pdb: 'prc',
  fb2: 'fb2',
  fbz: 'fbz',
  cbz: 'cbz',
  cbt: 'cbt',
  cbr: 'cbr',
  cb7: 'cb7',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  md: 'md',
  markdown: 'md',
  rtf: 'rtf',
  docx: 'docx',
  odt: 'odt',
  doc: 'doc',
}

/** 需要提示用户转换的格式（缺少纯前端解压/解码能力） */
export const UNSUPPORTED_HINT: Partial<Record<BookFormat, string>> = {
  cbr: 'CBR 使用 RAR 私有压缩算法，浏览器内无法解压，请转换为 CBZ/ZIP 或 EPUB 后导入。',
  cb7: 'CB7 使用 7z 压缩算法，浏览器内无法解压，请转换为 CBZ/ZIP 后导入。',
  doc: '旧版 .doc 为二进制复合文档，请另存为 .docx 或 .txt 后导入。',
}

/** 默认阅读设置 */
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  mode: 'paged',
  fontSize: 19,
  lineHeight: 1.8,
  fontFamily: 'serif',
  padding: 48,
  theme: 'light',
  locale: 'zh-CN',
}

/** 默认听书设置 */
export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  rate: 1,
  pitch: 1,
  volume: 1,
  voiceURI: '',
}

/** 默认翻译设置 */
export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  libreUrl: 'https://libretranslate.com',
  targetLang: 'zh',
}

/** 默认 WebDAV 设置 */
export const DEFAULT_WEBDAV_SETTINGS: WebdavSettings = {
  url: '',
  username: '',
  password: '',
  filename: 'dbx-ebook-backup.dbxebook',
  autoSync: false,
}

/** localStorage 键名 */
export const LS_READER = 'dbx-ebook:reader-settings'
export const LS_TTS = 'dbx-ebook:tts-settings'
export const LS_TRANSLATE = 'dbx-ebook:translate-settings'
export const LS_WEBDAV = 'dbx-ebook:webdav-settings'
export const LS_LAST_BOOK = 'dbx-ebook:last-book'
