<!-- 阅读器主视图：统一调度文字流 / PDF / 漫画三种文档，并集成听书、笔记、翻译 -->
<template>
  <div class="reader" :style="themeVars">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="left">
        <button class="icon-btn" :title="t('reader.bookshelf')" @click="emit('back')">
          <AppIcon name="arrowLeft" />
        </button>
        <div class="title-block">
          <h1 :title="doc?.title">{{ doc?.title || t('common.loading') }}</h1>
          <span class="chapter">{{ chapterTitle }}</span>
        </div>
      </div>

      <div class="right">
        <button class="icon-btn" :class="{ active: tocOpen }" :title="t('reader.toc')" @click="toggle('toc')">
          <AppIcon name="toc" />
        </button>
        <button class="icon-btn" :class="{ active: noteOpen }" :title="t('reader.notes')" @click="toggle('note')">
          <AppIcon name="note" />
        </button>
        <button
          class="icon-btn"
          :class="{ active: ttsState !== 'idle' }"
          :title="t('reader.listen')"
          :disabled="!canListen"
          @click="toggleTts"
        >
          <AppIcon name="headphones" />
        </button>
        <button class="icon-btn" :title="t('reader.settings')" @click="toggle('settings')">
          <AppIcon name="settings" />
        </button>
        <button class="icon-btn" :title="t('backup.title')" @click="backupOpen = true">
          <AppIcon name="cloud" />
        </button>
        <div v-if="isPdf" class="zoom">
          <button class="icon-btn" @click="setZoom(-0.1)"><AppIcon name="zoomOut" /></button>
          <span>{{ Math.round(zoom * 100) }}%</span>
          <button class="icon-btn" @click="setZoom(0.1)"><AppIcon name="zoomIn" /></button>
        </div>
      </div>
    </header>

    <!-- 正文 -->
    <main class="body">
      <div v-if="loading" class="state">
        <span class="spinner" />
        <p>{{ t('reader.loading') }}</p>
      </div>

      <div v-else-if="error" class="state error">
        <AppIcon name="info" :size="28" />
        <p class="err-title">{{ t('reader.failed') }}</p>
        <p class="err-desc">{{ error }}</p>
        <div class="state-actions">
          <button class="btn btn-ghost" @click="emit('back')">{{ t('reader.bookshelf') }}</button>
          <button class="btn btn-primary" @click="load">{{ t('common.retry') }}</button>
        </div>
      </div>

      <template v-else-if="doc">
        <FlowReader
          v-if="doc.kind === 'flow'"
          ref="flowRef"
          :doc="doc"
          :settings="settings.reader"
          :notes="notes"
          :initial-chapter="initialChapter"
          :initial-page="initialPage"
          :initial-percent="initialPercent"
          @progress="onFlowProgress"
          @selection="onSelection"
          @ready="onFlowReady"
        />

        <PdfReader
          v-else-if="doc.kind === 'pdf'"
          ref="pdfRef"
          :doc="doc"
          :settings="settings.reader"
          :notes="notes"
          :initial-page="initialChapter"
          :zoom="zoom"
          @progress="onPdfProgress"
          @selection="onSelection"
          @ready="onPdfReady"
          @loaded="onPdfLoaded"
        />

        <ComicReader
          v-else
          ref="comicRef"
          :doc="doc"
          :settings="settings.reader"
          :initial-page="initialChapter"
          @progress="onComicProgress"
          @ready="onComicReady"
        />
      </template>
    </main>

    <!-- 底部进度 -->
    <footer v-if="doc" class="footer">
      <button class="nav" :title="t('reader.prev')" @click="turn(-1)"><AppIcon name="chevronLeft" /></button>
      <div class="track">
        <input
          class="range"
          type="range"
          min="0"
          max="1000"
          :value="Math.round(bookPercent * 1000)"
          @input="onSeek"
        />
        <div class="labels">
          <span>{{ progressLabel }}</span>
          <span>{{ t('reader.bookProgress', { n: Math.round(bookPercent * 100) }) }}</span>
        </div>
      </div>
      <button class="nav" :title="t('reader.next')" @click="turn(1)"><AppIcon name="chevronRight" /></button>
    </footer>

    <!-- 听书控制条 -->
    <transition name="slide-up">
      <div v-if="ttsState !== 'idle'" class="tts-bar">
        <AppIcon name="headphones" :size="16" />
        <span class="tts-text">{{ ttsLabel }}</span>
        <button class="btn btn-ghost" @click="pauseOrResume">
          {{ ttsState === 'playing' ? t('tts.pause') : t('tts.resume') }}
        </button>
        <button class="btn btn-ghost" @click="stopTts">{{ t('tts.stop') }}</button>
      </div>
    </transition>

    <!-- 面板 -->
    <TocPanel
      :open="tocOpen"
      :toc="doc?.toc ?? []"
      :current-chapter="currentChapter"
      @close="tocOpen = false"
      @select="jumpTo"
    />
    <NotePanel
      :open="noteOpen"
      :notes="notes"
      :chapter-titles="chapterTitles"
      @close="noteOpen = false"
      @select="jumpToNote"
      @delete="removeNote"
      @export="exportNotes"
    />
    <SettingsPanel
      :open="settingsOpen"
      @close="settingsOpen = false"
      @backup="backupOpen = true"
    />

    <!-- 选中操作 -->
    <SelectionPopover
      :visible="selectionVisible"
      :rect="selectionRect"
      @highlight="createHighlight"
      @note="createNoteDraft"
      @translate="translateSelection"
      @copy="copySelection"
    />

    <TranslateDialog v-model="translateOpen" :source="selectedText" @config="openTranslateConfig" @copied="toast(t('common.copied'))" />

    <BackupDialog v-model="backupOpen" @toast="toast" @changed="emit('changed')" />

    <ConfirmDialog
      v-model="noteDeleteOpen"
      :title="t('notes.delete')"
      :description="t('shelf.delete.desc', { title: notePending?.text.slice(0, 40) ?? '' })"
      :confirm-text="t('common.delete')"
      @confirm="confirmRemoveNote"
    />

    <!-- 批注输入 -->
    <teleport to="body">
      <transition name="fade">
        <div v-if="noteEditorOpen" class="mask" @click.self="noteEditorOpen = false">
          <div class="note-dialog">
            <h3>{{ t('notes.add') }}</h3>
            <p class="quote">{{ noteDraft.text }}</p>
            <textarea v-model="noteDraft.comment" :placeholder="t('notes.placeholder')" rows="4" />
            <div class="note-actions">
              <div class="colors">
                <button
                  v-for="(value, key) in NOTE_COLORS"
                  :key="key"
                  class="dot"
                  :class="{ on: noteDraft.color === key }"
                  :style="{ background: value.border }"
                  @click="noteDraft.color = key"
                />
              </div>
              <div class="btns">
                <button class="btn btn-ghost" @click="noteEditorOpen = false">{{ t('common.cancel') }}</button>
                <button class="btn btn-primary" @click="saveNoteDraft">{{ t('common.save') }}</button>
              </div>
            </div>
          </div>
        </div>
      </transition>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AppIcon from './ui/AppIcon.vue'
import ConfirmDialog from './ui/ConfirmDialog.vue'
import SelectionPopover from './SelectionPopover.vue'
import TranslateDialog from './TranslateDialog.vue'
import ComicReader from './reader/ComicReader.vue'
import FlowReader from './reader/FlowReader.vue'
import PdfReader from './reader/PdfReader.vue'
import NotePanel from './panels/NotePanel.vue'
import SettingsPanel from './panels/SettingsPanel.vue'
import BackupDialog from './panels/BackupDialog.vue'
import TocPanel from './panels/TocPanel.vue'
import { NOTE_COLORS, PROGRESS_SAVE_DELAY, READING_COLUMN_MAX, THEMES } from '../core/constants'
import { deleteNote, getBook, listNotes, putNote } from '../core/db'
import { copyText } from '../core/host'
import { openBook, saveProgress } from '../core/library'
import { notesToMarkdown, downloadBlob } from '../core/backup'
import { settings } from '../core/settings'
import { buildSegments, TtsPlayer, type SpeechSegment, type TtsState } from '../core/tts'
import type { BookDoc, NoteColor, NoteRecord } from '../core/types'
import { uid } from '../core/utils'
import { t } from '../i18n'

const props = defineProps<{ bookId: string }>()

const emit = defineEmits<{
  (event: 'back'): void
  (event: 'changed'): void
  (event: 'toast', message: string, type?: 'info' | 'success' | 'error'): void
}>()

const doc = ref<BookDoc | null>(null)
const loading = ref(true)
const error = ref('')
const notes = ref<NoteRecord[]>([])
const chapterTitle = ref('')
const currentChapter = ref(0)
const pageCount = ref(1)
const pagePercent = ref(0)
const bookPercent = ref(0)
const zoom = ref(1)

const initialChapter = ref(0)
const initialPage = ref(0)
const initialPercent = ref(0)

const tocOpen = ref(false)
const noteOpen = ref(false)
const settingsOpen = ref(false)
const backupOpen = ref(false)
const translateOpen = ref(false)
const noteDeleteOpen = ref(false)
const notePending = ref<NoteRecord | null>(null)
const noteEditorOpen = ref(false)

const flowRef = ref<InstanceType<typeof FlowReader> | null>(null)
const pdfRef = ref<InstanceType<typeof PdfReader> | null>(null)
const comicRef = ref<InstanceType<typeof ComicReader> | null>(null)

const selectionVisible = ref(false)
const selectionRect = ref<DOMRect | null>(null)
const selectedText = ref('')
const selectionRange = ref<{ start: number; end: number }>({ start: 0, end: 0 })

const noteDraft = reactive({
  text: '',
  comment: '',
  color: 'yellow' as NoteColor,
  start: 0,
  end: 0,
  chapterIndex: 0,
})

const ttsState = ref<TtsState>('idle')
const ttsLabel = ref('')
const ttsSegments = ref<SpeechSegment[]>([])
const ttsContinuing = ref(false)

let saveTimer: ReturnType<typeof setTimeout> | null = null
let seekTimer: ReturnType<typeof setTimeout> | null = null
let disposed = false

/** 主题样式变量 */
const themeVars = computed(() => {
  const theme = THEMES[settings.reader.theme]
  return {
    '--rd-bg': theme.bg,
    '--rd-paper': theme.paper,
    '--rd-text': theme.text,
    '--rd-sub': theme.sub,
    '--rd-border': theme.border,
    '--reader-padding': `${settings.reader.padding}px`,
    /* 与 READING_COLUMN_MAX 保持一致，分页与滚动两种模式共用同一栏宽 */
    '--reader-column': `${READING_COLUMN_MAX}px`,
    background: theme.bg,
    color: theme.text,
  } as Record<string, string>
})

/** 是否 PDF */
const isPdf = computed(() => doc.value?.kind === 'pdf')

/** 面板是否展开（展开时不自动隐藏顶栏） */
const panelOpen = computed(() => tocOpen.value || noteOpen.value || settingsOpen.value || noteOpen.value)

/** 是否可听书 */
const canListen = computed(() => doc.value?.kind !== 'comic')

/** 章节标题列表 */
const chapterTitles = computed(() => doc.value?.chapters.map((chapter) => chapter.title) ?? [])

/** 进度文案 */
const progressLabel = computed(() => {
  if (doc.value?.kind === 'pdf') {
    return t('reader.pageOf', { current: currentChapter.value + 1, total: pageCount.value })
  }
  if (doc.value?.kind === 'comic') {
    return t('reader.pageOf', { current: currentChapter.value + 1, total: pageCount.value })
  }
  return t('reader.chapterProgress', { n: Math.round(pagePercent.value * 100) })
})

/** 听书引擎 */
const player = new TtsPlayer({
  onStateChange: (state) => {
    ttsState.value = state
  },
  onSegment: (index, segment) => {
    ttsLabel.value = segment.text.slice(0, 28)
    if (doc.value?.kind === 'flow') flowRef.value?.markSpeech(segment.paragraph)
    else if (doc.value?.kind === 'pdf') pdfRef.value?.markSpeech(segment.paragraph)
    void index
  },
  onFinished: () => {
    void continueTts()
  },
  onError: (message) => {
    emit('toast', message, 'error')
    ttsState.value = 'idle'
  },
})

/** 载入书籍 */
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const meta = await getBook(props.bookId)
    if (!meta) throw new Error('书籍不存在')
    initialChapter.value = meta.progress?.chapterIndex ?? 0
    initialPage.value = meta.progress?.page ?? 0
    initialPercent.value = meta.progress?.percent ?? 0
    currentChapter.value = initialChapter.value

    const parsed = await openBook(props.bookId)
    if (disposed) return
    doc.value = parsed
    notes.value = await listNotes(props.bookId)
    pageCount.value = parsed.kind === 'pdf' ? parsed.pageCount ?? 1 : parsed.kind === 'comic' ? parsed.pages?.length ?? 1 : 1
    chapterTitle.value = parsed.chapters[currentChapter.value]?.title ?? ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : '未知错误'
  } finally {
    loading.value = false
  }
}

/** 进度更新（文字流） */
function onFlowProgress(payload: { chapterIndex: number; page: number; percent: number }): void {
  currentChapter.value = payload.chapterIndex
  pagePercent.value = payload.percent
  const total = doc.value?.chapters.length ?? 1
  bookPercent.value = Math.min((payload.chapterIndex + payload.percent) / total, 1)
  scheduleSave({ chapterIndex: payload.chapterIndex, page: payload.page, percent: payload.percent, bookPercent: bookPercent.value })
}

/** 章节就绪 */
function onFlowReady(payload: { chapterIndex: number; title: string; paragraphs: string[] }): void {
  currentChapter.value = payload.chapterIndex
  chapterTitle.value = payload.title
  if (ttsState.value !== 'idle' && payload.paragraphs.length) {
    ttsSegments.value = buildSegments(payload.paragraphs.join('\n'))
  }
}

/** PDF 进度 */
function onPdfProgress(payload: { page: number; percent: number }): void {
  currentChapter.value = payload.page
  pagePercent.value = payload.percent
  bookPercent.value = payload.percent
  scheduleSave({ chapterIndex: payload.page, page: 0, percent: payload.percent, bookPercent: payload.percent })
}

/** PDF 页信息 */
function onPdfReady(payload: { page: number; paragraphs: string[] }): void {
  currentChapter.value = payload.page
  chapterTitle.value = t('reader.pageOf', { current: payload.page + 1, total: pageCount.value })
  if (ttsState.value !== 'idle' && payload.paragraphs.length) {
    ttsSegments.value = buildSegments(payload.paragraphs.join('\n'))
  }
}

/** PDF 页数载入 */
function onPdfLoaded(payload: { pageCount: number }): void {
  pageCount.value = payload.pageCount
}

/** 漫画进度 */
function onComicProgress(payload: { page: number; percent: number }): void {
  currentChapter.value = payload.page
  pageCount.value = doc.value?.pages?.length ?? 1
  bookPercent.value = payload.percent
  pagePercent.value = payload.percent
  scheduleSave({ chapterIndex: payload.page, page: 0, percent: payload.percent, bookPercent: payload.percent })
}

/** 漫画就绪 */
function onComicReady(payload: { page: number }): void {
  currentChapter.value = payload.page
  chapterTitle.value = t('reader.pageOf', { current: payload.page + 1, total: pageCount.value })
}

/** 延迟保存进度，避免高频写库 */
function scheduleSave(progress: { chapterIndex: number; page: number; percent: number; bookPercent: number }): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void saveProgress(props.bookId, progress).catch((err) => console.warn('[reader] 保存进度失败', err))
  }, PROGRESS_SAVE_DELAY)
}

/** 键盘与窗口事件 */
function onKeydown(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
  switch (event.key) {
    case 'ArrowRight':
    case 'PageDown':
    case ' ':
      event.preventDefault()
      turn(1)
      break
    case 'ArrowLeft':
    case 'PageUp':
      event.preventDefault()
      turn(-1)
      break
    case 'Escape':
      if (noteEditorOpen.value) noteEditorOpen.value = false
      else if (translateOpen.value) translateOpen.value = false
      else if (backupOpen.value) backupOpen.value = false
      else if (panelOpen.value) closePanels()
      break
    default:
      break
  }
}

/** 翻页 */
function turn(direction: 1 | -1): void {
  if (doc.value?.kind === 'flow') {
    if (direction === 1) flowRef.value?.next()
    else flowRef.value?.prev()
    return
  }
  if (doc.value?.kind === 'pdf') {
    if (direction === 1) pdfRef.value?.next()
    else pdfRef.value?.prev()
    return
  }
  if (direction === 1) comicRef.value?.next()
  else comicRef.value?.prev()
}

/** 进度条拖动 */
function onSeek(event: Event): void {
  const ratio = Number((event.target as HTMLInputElement).value) / 1000
  if (seekTimer) clearTimeout(seekTimer)
  seekTimer = setTimeout(() => {
    if (doc.value?.kind === 'flow') {
      const total = doc.value.chapters.length
      const chapterIndex = Math.min(Math.floor(ratio * total), total - 1)
      void flowRef.value?.goToChapter(chapterIndex)
    } else if (doc.value?.kind === 'pdf') {
      void pdfRef.value?.goToPage(Math.round(ratio * (pageCount.value - 1)))
    }
  }, 120)
}

/** 面板互斥切换 */
function toggle(target: 'toc' | 'note' | 'settings'): void {
  const next = target === 'toc' ? !tocOpen.value : target === 'note' ? !noteOpen.value : !settingsOpen.value
  closePanels()
  if (target === 'toc') tocOpen.value = next
  if (target === 'note') noteOpen.value = next
  if (target === 'settings') settingsOpen.value = next
}

/** 关闭全部面板 */
function closePanels(): void {
  tocOpen.value = false
  noteOpen.value = false
  settingsOpen.value = false
}

/** 目录跳转 */
function jumpTo(chapterIndex: number): void {
  if (doc.value?.kind === 'flow') void flowRef.value?.goToChapter(chapterIndex)
  else if (doc.value?.kind === 'pdf') void pdfRef.value?.goToPage(chapterIndex)
  else void comicRef.value?.goToPage(chapterIndex)
}

/** 选中回调 */
function onSelection(payload: { text: string; start: number; end: number; rect: DOMRect } | null): void {
  if (!payload) {
    selectionVisible.value = false
    return
  }
  selectedText.value = payload.text
  selectionRange.value = { start: payload.start, end: payload.end }
  selectionRect.value = payload.rect
  selectionVisible.value = true
}

/** 创建纯高亮 */
async function createHighlight(color: NoteColor): Promise<void> {
  await persistNote('', color)
}

/** 打开批注输入 */
function createNoteDraft(): void {
  if (!selectedText.value.trim()) return
  noteDraft.text = selectedText.value
  noteDraft.comment = ''
  noteDraft.color = 'yellow'
  noteDraft.start = selectionRange.value.start
  noteDraft.end = selectionRange.value.end
  noteDraft.chapterIndex = currentChapter.value
  noteEditorOpen.value = true
  selectionVisible.value = false
}

/** 保存批注 */
async function saveNoteDraft(): Promise<void> {
  await persistNote(noteDraft.comment, noteDraft.color)
  noteEditorOpen.value = false
  emit('toast', t('notes.saved'), 'success')
}

/** 写入笔记 */
async function persistNote(comment: string, color: NoteColor): Promise<void> {
  const text = noteEditorOpen.value ? noteDraft.text : selectedText.value
  const range = noteEditorOpen.value
    ? { start: noteDraft.start, end: noteDraft.end }
    : selectionRange.value
  const chapterIndex = noteEditorOpen.value ? noteDraft.chapterIndex : currentChapter.value
  if (!text.trim()) return
  const now = Date.now()
  const note: NoteRecord = {
    id: uid('note'),
    bookId: props.bookId,
    chapterIndex,
    start: range.start,
    end: range.end,
    text,
    comment,
    color,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await putNote(note)
    notes.value = [...notes.value, note]
    selectionVisible.value = false
    window.getSelection()?.removeAllRanges()
    emit('toast', t('notes.saved'), 'success')
  } catch (err) {
    emit('toast', err instanceof Error ? err.message : '保存失败', 'error')
  }
}

/** 删除笔记（二次确认） */
function removeNote(id: string): void {
  notePending.value = notes.value.find((note) => note.id === id) ?? null
  noteDeleteOpen.value = true
}

/** 确认删除笔记 */
async function confirmRemoveNote(): Promise<void> {
  if (!notePending.value) return
  await deleteNote(notePending.value.id)
  notes.value = notes.value.filter((note) => note.id !== notePending.value?.id)
  noteDeleteOpen.value = false
  notePending.value = null
  emit('toast', t('toast.deleted'), 'success')
}

/** 跳转到笔记位置 */
async function jumpToNote(note: NoteRecord): Promise<void> {
  noteOpen.value = false
  await jumpTo(note.chapterIndex)
}

/** 导出笔记 */
function exportNotes(): void {
  if (!doc.value) return
  const blob = notesToMarkdown(doc.value.title, notes.value, chapterTitles.value)
  downloadBlob(blob, `${doc.value.title}-笔记.md`)
  emit('toast', t('toast.exported'), 'success')
}

/** 翻译选中内容 */
function translateSelection(): void {
  if (!selectedText.value.trim()) return
  selectionVisible.value = false
  translateOpen.value = true
}

/** 复制选中内容 */
async function copySelection(): Promise<void> {
  const ok = await copyText(selectedText.value)
  emit('toast', ok ? t('common.copied') : '复制失败', ok ? 'success' : 'error')
  selectionVisible.value = false
}

/** 打开翻译配置 */
function openTranslateConfig(): void {
  translateOpen.value = false
  settingsOpen.value = true
}

/** 听书开关 */
async function toggleTts(): Promise<void> {
  if (ttsState.value !== 'idle') {
    stopTts()
    return
  }
  if (!TtsPlayer.isSupported()) {
    emit('toast', t('tts.unsupported'), 'error')
    return
  }
  await startTts()
}

/** 开始朗读当前章节 / 页 */
async function startTts(fromSegment = 0): Promise<void> {
  const paragraphs = collectParagraphs()
  if (!paragraphs.length) {
    emit('toast', t('tts.noText'), 'error')
    return
  }
  ttsSegments.value = buildSegments(paragraphs.join('\n'))
  player.setSegments(ttsSegments.value)
  player.play(fromSegment)
}

/** 暂停 / 继续 */
function pauseOrResume(): void {
  if (ttsState.value === 'playing') player.pause()
  else player.resume()
}

/** 停止 */
function stopTts(): void {
  ttsContinuing.value = false
  player.stop()
  ttsLabel.value = ''
}

/** 自动续读下一章 */
async function continueTts(): Promise<void> {
  if (ttsContinuing.value) return
  if (doc.value?.kind !== 'flow') {
    stopTts()
    return
  }
  const nextChapter = currentChapter.value + 1
  if (nextChapter >= (doc.value.chapters.length ?? 0)) {
    stopTts()
    return
  }
  ttsContinuing.value = true
  await flowRef.value?.goToChapter(nextChapter)
  await nextTick()
  const paragraphs = collectParagraphs()
  if (!paragraphs.length) {
    stopTts()
    return
  }
  ttsSegments.value = buildSegments(paragraphs.join('\n'))
  player.setSegments(ttsSegments.value)
  player.play(0)
  ttsContinuing.value = false
}

/** 收集当前视图段落 */
function collectParagraphs(): string[] {
  if (doc.value?.kind === 'flow') return flowRef.value?.getParagraphs() ?? []
  if (doc.value?.kind === 'pdf') return pdfRef.value?.getParagraphs() ?? []
  return []
}

/** 缩放 */
function setZoom(delta: number): void {
  zoom.value = Math.min(Math.max(Math.round((zoom.value + delta) * 100) / 100, 0.6), 3)
}

/** 提示转发 */
function toast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
  emit('toast', message, type)
}

onMounted(async () => {
  await load()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('keydown', onKeydown)
  if (saveTimer) clearTimeout(saveTimer)
  if (seekTimer) clearTimeout(seekTimer)
  player.stop()
})
</script>

<style scoped>
.reader {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--rd-bg);
  overflow: hidden;
  transition: background 0.24s;
}

.topbar {
  position: relative;
  flex: none;
  height: 54px;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 0 8px;
  background: color-mix(in srgb, var(--rd-paper) 88%, transparent);
  border-bottom: 1px solid var(--rd-border);
  backdrop-filter: blur(10px);
  z-index: 30;
}

.left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.title-block {
  min-width: 0;
}

.title-block h1 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  max-width: 42vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chapter {
  display: block;
  font-size: 11px;
  color: var(--rd-sub);
  max-width: 42vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.right {
  display: flex;
  align-items: center;
  gap: 2px;
}

.zoom {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 6px;
  padding-left: 8px;
  border-left: 1px solid var(--rd-border);
  font-size: 11px;
  color: var(--rd-sub);
}

.zoom span {
  min-width: 34px;
  text-align: center;
}

.body {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--rd-sub);
  font-size: 13px;
}

.state .spinner {
  width: 22px;
  height: 22px;
  border: 2px solid rgba(79, 124, 255, 0.2);
  border-top-color: var(--c-primary);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.err-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--rd-text);
}

.err-desc {
  margin: 0;
  max-width: 520px;
  text-align: center;
  line-height: 1.7;
  font-size: 12.5px;
}

.state-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}

.footer {
  position: relative;
  flex: none;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  background: color-mix(in srgb, var(--rd-paper) 86%, transparent);
  border-top: 1px solid var(--rd-border);
  backdrop-filter: blur(10px);
  z-index: 20;
}

.nav {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--rd-sub);
}

.nav:hover {
  background: rgba(127, 127, 127, 0.1);
  color: var(--rd-text);
}

.track {
  flex: 1;
}

.range {
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--c-primary);
  height: 14px;
}

.labels {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--rd-sub);
  margin-top: 2px;
}

.tts-bar {
  position: absolute;
  left: 50%;
  bottom: 72px;
  transform: translateX(-50%);
  z-index: 25;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--c-panel);
  border-radius: 999px;
  box-shadow: var(--shadow-m);
}

.tts-text {
  font-size: 12px;
  color: var(--c-text-2);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}

.mask {
  position: fixed;
  inset: 0;
  background: rgba(18, 22, 30, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2400;
}

.note-dialog {
  width: min(460px, 90vw);
  background: var(--c-panel);
  border-radius: var(--radius-l);
  padding: 20px;
  box-shadow: var(--shadow-l);
}

.note-dialog h3 {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.quote {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-left: 3px solid #f0b429;
  background: var(--c-subtle);
  border-radius: 6px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--c-text-2);
  max-height: 110px;
  overflow-y: auto;
}

.note-dialog textarea {
  width: 100%;
  resize: vertical;
  line-height: 1.6;
}

.note-actions {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.colors {
  display: flex;
  gap: 6px;
}

.dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid transparent;
}

.dot.on {
  border-color: rgba(0, 0, 0, 0.22);
  transform: scale(1.1);
}

.btns {
  display: flex;
  gap: 8px;
}

@media (max-width: 720px) {
  .title-block h1,
  .chapter {
    max-width: 34vw;
  }

  .zoom {
    display: none;
  }

  .footer {
    height: 50px;
    padding: 0 8px;
  }
}
</style>
