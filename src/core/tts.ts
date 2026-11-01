/**
 * 听书引擎：基于 Web Speech API（speechSynthesis）
 * 关键设计：
 * 1. 逐句合成，规避 Chrome 长文本（>200 字）自动中断的问题
 * 2. 通过队列 + onend 链式驱动，支持暂停/继续/跳句
 * 3. 每句开始都会回调，用于正文朗读高亮
 */
import { settings } from './settings'

/** 单句最大字符数 */
const MAX_SENTENCE_LEN = 120

/** 播放状态 */
export type TtsState = 'idle' | 'playing' | 'paused'

/** 语音可选信息 */
export interface VoiceOption {
  uri: string
  name: string
  lang: string
}

/** 句子 + 所属段落的映射（用于高亮定位） */
export interface SpeechSegment {
  text: string
  /** 所属段落在章节内的序号 */
  paragraph: number
}

/**
 * 把章节纯文本切分为适合朗读的短句
 * @param text 章节文本
 * @param paragraphBase 段落起始序号（跨章节累加时使用）
 */
export function buildSegments(text: string, paragraphBase = 0): SpeechSegment[] {
  const paragraphs = text.split(/\n+/).filter((line) => line.trim())
  const segments: SpeechSegment[] = []
  paragraphs.forEach((paragraph, paragraphIndex) => {
    // 按中英文句末标点切句
    const sentences = paragraph
      .replace(/([。！？!?；;…]+)/g, '$1\u0001')
      .split('\u0001')
      .map((sentence) => sentence.trim())
      .filter(Boolean)
    let buffer = ''
    const pushBuffer = () => {
      if (buffer.trim()) segments.push({ text: buffer.trim(), paragraph: paragraphBase + paragraphIndex })
      buffer = ''
    }
    sentences.forEach((sentence) => {
      if ((buffer + sentence).length > MAX_SENTENCE_LEN) {
        pushBuffer()
        if (sentence.length > MAX_SENTENCE_LEN) {
          // 超长无标点句：按长度硬切
          for (let i = 0; i < sentence.length; i += MAX_SENTENCE_LEN) {
            segments.push({
              text: sentence.slice(i, i + MAX_SENTENCE_LEN),
              paragraph: paragraphBase + paragraphIndex,
            })
          }
          return
        }
        buffer = sentence
        return
      }
      buffer += sentence
    })
    pushBuffer()
  })
  return segments
}

/** 听书播放器 */
export class TtsPlayer {
  private segments: SpeechSegment[] = []
  private index = 0
  private state: TtsState = 'idle'
  private utterance: SpeechSynthesisUtterance | null = null
  /** 每次停止时自增，用于丢弃过期的 onend 回调 */
  private generation = 0

  constructor(
    private readonly hooks: {
      onStateChange?: (state: TtsState) => void
      onSegment?: (index: number, segment: SpeechSegment) => void
      onFinished?: () => void
      onError?: (message: string) => void
    } = {},
  ) {}

  /** 当前是否可用 */
  static isSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
  }

  /** 获取可选语音（优先当前语言） */
  static async listVoices(lang = 'zh'): Promise<VoiceOption[]> {
    if (!TtsPlayer.isSupported()) return []
    const collect = (): VoiceOption[] =>
      window.speechSynthesis.getVoices().map((voice) => ({
        uri: voice.voiceURI,
        name: voice.name,
        lang: voice.lang,
      }))
    let voices = collect()
    if (!voices.length) {
      voices = await new Promise<VoiceOption[]>((resolve) => {
        const timer = setTimeout(() => resolve(collect()), 1200)
        window.speechSynthesis.onvoiceschanged = () => {
          clearTimeout(timer)
          resolve(collect())
        }
      })
    }
    const matched = voices.filter((voice) => voice.lang.toLowerCase().startsWith(lang.toLowerCase()))
    return matched.length ? matched : voices
  }

  /** 设置朗读队列 */
  setSegments(segments: SpeechSegment[]): void {
    this.segments = segments
  }

  /** 当前句子索引 */
  get currentIndex(): number {
    return this.index
  }

  /** 当前状态 */
  get currentState(): TtsState {
    return this.state
  }

  /** 从指定句子开始播放 */
  play(fromIndex = this.index): void {
    if (!TtsPlayer.isSupported()) {
      this.hooks.onError?.('当前环境不支持语音合成（Web Speech API）')
      return
    }
    if (!this.segments.length) {
      this.hooks.onError?.('当前章节没有可朗读的文本')
      return
    }
    this.stop(false)
    this.index = Math.min(Math.max(fromIndex, 0), this.segments.length - 1)
    this.generation += 1
    this.speakCurrent(this.generation)
  }

  /** 暂停 */
  pause(): void {
    if (!TtsPlayer.isSupported() || this.state !== 'playing') return
    window.speechSynthesis.pause()
    this.setState('paused')
  }

  /** 继续 */
  resume(): void {
    if (!TtsPlayer.isSupported()) return
    if (this.state === 'paused') {
      window.speechSynthesis.resume()
      this.setState('playing')
      return
    }
    if (this.state === 'idle') this.play(this.index)
  }

  /** 停止（重置到当前句） */
  stop(reset = true): void {
    this.generation += 1
    if (TtsPlayer.isSupported()) {
      window.speechSynthesis.cancel()
    }
    this.utterance = null
    if (reset) this.index = 0
    this.setState('idle')
  }

  /** 跳句 */
  seek(index: number): void {
    const target = Math.min(Math.max(index, 0), this.segments.length - 1)
    if (this.state === 'idle') {
      this.index = target
      return
    }
    this.play(target)
  }

  /** 更新状态 */
  private setState(state: TtsState): void {
    this.state = state
    this.hooks.onStateChange?.(state)
  }

  /** 朗读第 index 句，并在结束后链式推进 */
  private speakCurrent(generation: number): void {
    const segment = this.segments[this.index]
    if (!segment) {
      this.setState('idle')
      this.hooks.onFinished?.()
      return
    }
    const utterance = new SpeechSynthesisUtterance(segment.text)
    utterance.rate = settings.tts.rate
    utterance.pitch = settings.tts.pitch
    utterance.volume = settings.tts.volume

    const voices = window.speechSynthesis.getVoices()
    const preferred = settings.tts.voiceURI
      ? voices.find((voice) => voice.voiceURI === settings.tts.voiceURI)
      : undefined
    const autoVoice =
      preferred ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith('zh')) ??
      voices.find((voice) => voice.default)
    if (autoVoice) {
      utterance.voice = autoVoice
      utterance.lang = autoVoice.lang
    } else {
      utterance.lang = 'zh-CN'
    }

    utterance.onstart = () => {
      if (generation !== this.generation) return
      this.setState('playing')
      this.hooks.onSegment?.(this.index, segment)
    }
    utterance.onend = () => {
      // 丢弃过期回调（用户已停止或跳句）
      if (generation !== this.generation) return
      if (this.state === 'paused') return
      if (this.index + 1 >= this.segments.length) {
        this.setState('idle')
        this.hooks.onFinished?.()
        return
      }
      this.index += 1
      this.speakCurrent(generation)
    }
    utterance.onerror = (event) => {
      if (generation !== this.generation) return
      // interrupted / canceled 属正常交互，不提示
      if (event.error === 'interrupted' || event.error === 'canceled') return
      this.setState('idle')
      this.hooks.onError?.(`语音合成失败：${event.error}`)
    }

    this.utterance = utterance
    window.speechSynthesis.speak(utterance)
  }
}

/** 把朗读文本包裹为带高亮的 HTML（供阅读器高亮当前句） */
export function highlightSpeech(html: string, activeParagraph: number): string {
  const paragraphs = html.split(/(<\/p>)/i)
  let paragraphIndex = -1
  return paragraphs
    .map((chunk) => {
      if (/^<p[\s>]/i.test(chunk)) paragraphIndex += 1
      if (paragraphIndex === activeParagraph && !/^<\/p>$/i.test(chunk)) {
        return chunk.replace(/>$/, ' class="tts-active">')
      }
      return chunk
    })
    .join('')
}
