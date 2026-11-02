<!-- 文字流阅读器：单页 / 双页（CSS 多栏分页） / 滚动 -->
<template>
  <div class="flow-reader" :class="`mode-${settings.mode}`">
    <!-- 分页模式 -->
    <div v-if="settings.mode !== 'scroll'" ref="stageRef" class="stage" @mouseup="onMouseUp" @touchend="onMouseUp">
      <!-- 纸面（含内边距）与裁剪窗口分离：位移只作用在正文上，纸面永远不动 -->
      <div ref="frameRef" class="page-frame">
        <div ref="hostRef" class="page-host" />
      </div>
      <button class="edge edge-left" :aria-label="t('reader.prev')" @click="prev" />
      <button class="edge edge-right" :aria-label="t('reader.next')" @click="next" />
      <button class="pager pager-prev" :disabled="atStart" :aria-label="t('reader.prev')" :title="t('reader.prev')" @click.stop="prev">
        <AppIcon name="chevronLeft" :size="20" />
      </button>
      <button class="pager pager-next" :disabled="atEnd" :aria-label="t('reader.next')" :title="t('reader.next')" @click.stop="next">
        <AppIcon name="chevronRight" :size="20" />
      </button>
    </div>

    <!-- 滚动模式 -->
    <div v-else ref="scrollerRef" class="scroller" @scroll.passive="onScroll" @mouseup="onMouseUp" @touchend="onMouseUp">
      <div
        v-for="(chapter, index) in doc.chapters"
        :key="chapter.id"
        :ref="(el) => setShell(el as HTMLElement | null, index)"
        class="scroll-chapter"
        :data-index="index"
      />
      <div class="scroll-tail" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { COLUMN_GAP, DOUBLE_PAGE_MIN_WIDTH, READING_COLUMN_MAX } from '../../core/constants'
import {
  applyNotes,
  buildBookCss,
  clearNotes,
  listParagraphs,
  markSpeechBlock,
  mountChapter,
  readSelection,
  waitImages,
} from '../../core/render'
import type { BookDoc, NoteRecord, ReaderSettings } from '../../core/types'
import { t } from '../../i18n'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{
  doc: BookDoc
  settings: ReaderSettings
  notes: NoteRecord[]
  initialChapter: number
  initialPage: number
  initialPercent: number
}>()

const emit = defineEmits<{
  (event: 'progress', payload: { chapterIndex: number; page: number; percent: number }): void
  (event: 'selection', payload: { text: string; start: number; end: number; rect: DOMRect } | null): void
  (event: 'ready', payload: { chapterIndex: number; title: string; paragraphs: string[] }): void
}>()

const stageRef = ref<HTMLElement | null>(null)
const frameRef = ref<HTMLElement | null>(null)
const hostRef = ref<HTMLElement | null>(null)
const scrollerRef = ref<HTMLElement | null>(null)

const chapterIndex = ref(Math.min(Math.max(props.initialChapter, 0), props.doc.chapters.length - 1))
const page = ref(props.initialPage)
const pageCount = ref(1)
/** 一屏（单页或双页）的总宽度（px），即正文可见区宽度 */
const spreadWidth = ref(0)

const shells = new Map<number, HTMLElement>()
const mountedChapters = new Set<number>()
let observer: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null
/** 重建期间抑制滚动回调，避免进度抖动 */
let restoring = false

/** 注入书籍的样式表 */
const bookCss = computed(() => buildBookCss(props.settings, props.doc.cssText))

/** 当前章节 */
const currentChapter = computed(() => props.doc.chapters[chapterIndex.value])

/** 设置滚动容器的章节节点引用 */
function setShell(el: HTMLElement | null, index: number): void {
  if (!el) return
  shells.set(index, el)
}

/** 应用本章高亮 */
function applyChapterNotes(root: ShadowRoot, index: number): void {
  const list = props.notes.filter((note) => note.chapterIndex === index)
  if (list.length) applyNotes(root, list)
}

/** 分页模式：挂载章节并测量页数 */
async function renderPaged(keepPercent = false): Promise<void> {
  const host = hostRef.value
  const stage = stageRef.value
  if (!host || !stage || !currentChapter.value) return

  const ratio = keepPercent && pageCount.value > 1 ? page.value / (pageCount.value - 1) : 0
  const root = mountChapter(host, currentChapter.value, bookCss.value)
  await waitImages(root)
  applyChapterNotes(root, chapterIndex.value)
  measure(host, stage)
  if (keepPercent) page.value = Math.round(ratio * Math.max(pageCount.value - 1, 0))
  // 重建时直接落位，不做翻页动画（measure 已把位移归零，动画会横跨整章）
  setPage(page.value, false)
  emitReady()
}

/** 取分页容器内承载正文的节点（Shadow DOM 内的 .book） */
function bookElement(host: HTMLElement | null): HTMLElement | null {
  return (host?.shadowRoot?.querySelector('.book') as HTMLElement | null) ?? null
}

/**
 * 测量分页参数
 * 关键：纸面（.page-host）本身是固定不动的「窗口」，多栏布局与翻页位移都发生在
 * Shadow DOM 内的 .book 上。早期把 column-* 与 transform 都放在 host 上，
 * 结果是翻页时整张纸被移出 stage，第二页起屏幕只剩空白。
 */
function measure(host: HTMLElement, stage: HTMLElement): void {
  const frame = frameRef.value
  const stageStyle = getComputedStyle(stage)
  const padX = (parseFloat(stageStyle.paddingLeft) || 0) + (parseFloat(stageStyle.paddingRight) || 0)
  const padY = (parseFloat(stageStyle.paddingTop) || 0) + (parseFloat(stageStyle.paddingBottom) || 0)
  // 纸面内边距由 .page-frame 的 padding 提供，正文可用宽高都要先扣掉
  const insetX = frame ? (parseFloat(getComputedStyle(frame).paddingLeft) || 0) + (parseFloat(getComputedStyle(frame).paddingRight) || 0) : 0
  const insetY = frame ? (parseFloat(getComputedStyle(frame).paddingTop) || 0) + (parseFloat(getComputedStyle(frame).paddingBottom) || 0) : 0
  // clientWidth/clientHeight 含 padding，必须扣掉，否则窄屏下纸面会溢出被裁
  const available = Math.max(0, stage.clientWidth - padX - insetX)
  const height = Math.max(0, stage.clientHeight - padY - insetY)
  if (available < 120 || height < 120) return

  const wantDouble = props.settings.mode === 'double' && available >= DOUBLE_PAGE_MIN_WIDTH
  const perPage = wantDouble ? 2 : 1
  const columnWidth = wantDouble
    ? Math.min(READING_COLUMN_MAX, (available - COLUMN_GAP) / 2)
    : Math.min(READING_COLUMN_MAX, available)
  const spread = perPage === 2 ? columnWidth * 2 + COLUMN_GAP : columnWidth

  spreadWidth.value = spread

  if (frame) frame.style.width = `${spread}px`
  host.style.width = `${spread}px`
  host.style.height = `${height}px`

  const book = bookElement(host)
  if (book) {
    book.style.height = '100%'
    book.style.columnWidth = `${columnWidth}px`
    book.style.columnGap = `${COLUMN_GAP}px`
    book.style.columnFill = 'auto'
    // 关键：位移会让 .book 的内容包围盒整体左移，scrollWidth 随之变小 → 列数被低估。
    // 测量前必须先归零并关掉过渡，测量后再由 setPage 写回真实位移。
    book.style.transition = 'none'
    book.style.transform = 'translate3d(0px, 0px, 0px)'
  }

  // 强制重排后读取滚动宽度（host 为 overflow:hidden 的滚动容器，能反映 .book 的溢出列）
  const totalWidth = host.scrollWidth
  const totalColumns = Math.max(1, Math.round((totalWidth + COLUMN_GAP) / (columnWidth + COLUMN_GAP)))
  pageCount.value = Math.max(1, Math.ceil(totalColumns / perPage))
  page.value = Math.min(page.value, pageCount.value - 1)
}

/** 翻到指定页 */
function setPage(target: number, animate = true): void {
  const host = hostRef.value
  if (!host) return
  page.value = Math.min(Math.max(target, 0), Math.max(pageCount.value - 1, 0))
  const book = bookElement(host)
  if (book) {
    const step = spreadWidth.value + COLUMN_GAP
    // measure 为测量准确把过渡关掉了：翻页时先恢复并强制重排，位移才会走动画；
    // 重建落位则保持无动画，避免从第 1 页横跨整章滑到当前页。
    book.style.transition = animate ? '' : 'none'
    if (animate) void book.offsetWidth
    book.style.transform = `translate3d(${-page.value * step}px, 0, 0)`
  }
  emitProgress()
}

/** 滚动模式：挂载章节内容 */
async function mountForScroll(index: number): Promise<void> {
  const shell = shells.get(index)
  const chapter = props.doc.chapters[index]
  if (!shell || !chapter) return
  const root = mountChapter(shell, chapter, bookCss.value)
  await waitImages(root)
  applyChapterNotes(root, index)
  mountedChapters.add(index)
}

/** 滚动容器滚动处理 */
function onScroll(): void {
  if (restoring) return
  const scroller = scrollerRef.value
  if (!scroller) return
  // 以视口中线判定当前章节
  const middle = scroller.scrollTop + scroller.clientHeight / 2
  let active = chapterIndex.value
  for (const [index, shell] of shells) {
    const top = shell.offsetTop
    const bottom = top + shell.offsetHeight
    if (middle >= top && middle < bottom) {
      active = index
      break
    }
  }
  if (active !== chapterIndex.value) {
    chapterIndex.value = active
    emitReady()
  }
  const shell = shells.get(active)
  let percent = 0
  if (shell && shell.offsetHeight > 0) {
    percent = (middle - shell.offsetTop) / shell.offsetHeight
  }
  page.value = 0
  pageCount.value = 1
  emitProgress(Math.min(Math.max(percent, 0), 1))
}

/** 分发进度 */
function emitProgress(percentOverride?: number): void {
  const percent =
    percentOverride ??
    (props.settings.mode === 'scroll'
      ? 0
      : pageCount.value > 1
        ? page.value / (pageCount.value - 1)
        : 0)
  emit('progress', {
    chapterIndex: chapterIndex.value,
    page: page.value,
    percent,
  })
}

/** 通知父级当前章节信息（用于听书与标题） */
function emitReady(): void {
  const root = currentShadow()
  emit('ready', {
    chapterIndex: chapterIndex.value,
    title: currentChapter.value?.title ?? '',
    paragraphs: root ? listParagraphs(root) : [],
  })
}

/** 取当前章节 ShadowRoot */
function currentShadow(): ShadowRoot | null {
  if (props.settings.mode === 'scroll') {
    return shells.get(chapterIndex.value)?.shadowRoot ?? null
  }
  return hostRef.value?.shadowRoot ?? null
}

/** 是否已到全书首 / 末页（用于禁用翻页按钮） */
const atStart = computed(() => chapterIndex.value <= 0 && page.value <= 0)
const atEnd = computed(() => chapterIndex.value >= props.doc.chapters.length - 1 && page.value >= pageCount.value - 1)

/** 下一页 */
function next(): void {
  if (props.settings.mode === 'scroll') {
    scrollerRef.value?.scrollBy({ top: scrollerRef.value.clientHeight * 0.9, behavior: 'smooth' })
    return
  }
  if (page.value < pageCount.value - 1) {
    setPage(page.value + 1)
    return
  }
  if (chapterIndex.value < props.doc.chapters.length - 1) {
    goToChapter(chapterIndex.value + 1, 0)
  }
}

/** 上一页 */
function prev(): void {
  if (props.settings.mode === 'scroll') {
    scrollerRef.value?.scrollBy({ top: -scrollerRef.value.clientHeight * 0.9, behavior: 'smooth' })
    return
  }
  if (page.value > 0) {
    setPage(page.value - 1)
    return
  }
  if (chapterIndex.value > 0) {
    goToChapter(chapterIndex.value - 1, Number.MAX_SAFE_INTEGER)
  }
}

/**
 * 跳转到章节
 * @param index 章节索引
 * @param targetPage 目标页（MAX_SAFE_INTEGER 表示最后一页）
 */
async function goToChapter(index: number, targetPage = 0): Promise<void> {
  const target = Math.min(Math.max(index, 0), props.doc.chapters.length - 1)
  if (props.settings.mode === 'scroll') {
    chapterIndex.value = target
    await nextTick()
    const shell = shells.get(target)
    if (shell) {
      restoring = true
      scrollerRef.value?.scrollTo({ top: shell.offsetTop, behavior: 'auto' })
      setTimeout(() => {
        restoring = false
      }, 60)
    }
    emitReady()
    return
  }

  chapterIndex.value = target
  page.value = targetPage === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : targetPage
  await nextTick()
  await renderPaged(false)
  if (targetPage === Number.MAX_SAFE_INTEGER) setPage(pageCount.value - 1)
  emitReady()
}

/** 鼠标抬起：读取选中文本 */
function onMouseUp(): void {
  // 延迟一帧，保证 selection 已更新
  requestAnimationFrame(() => {
    const root = currentShadow()
    if (!root) return
    // readSelection 会把选中范围和浮条定位用的矩形一起算好：
    // Shadow DOM 下 window.getSelection() 拿到的是折叠到宿主的空范围，矩形也是 0
    const result = readSelection(root)
    if (!result || !result.text.trim()) {
      emit('selection', null)
      return
    }
    emit('selection', result)
  })
}

/** 高亮朗读段落 */
function markSpeech(blockIndex: number): void {
  const root = currentShadow()
  if (root) markSpeechBlock(root, blockIndex)
}

/** 取当前章节段落（供听书） */
function getParagraphs(): string[] {
  const root = currentShadow()
  return root ? listParagraphs(root) : []
}

/** 当前章节纯文本长度（用于进度百分比估算） */
function chapterTextLength(index: number): number {
  return props.doc.chapters[index]?.text.length ?? 0
}

/** 启用滚动模式的懒加载观察器 */
async function setupScroll(): Promise<void> {
  observer?.disconnect()
  await nextTick()
  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        const index = Number((entry.target as HTMLElement).dataset.index ?? '0')
        if (mountedChapters.has(index)) return
        void mountForScroll(index)
      })
    },
    { root: scrollerRef.value, rootMargin: '800px 0px' },
  )
  shells.forEach((shell) => observer?.observe(shell))
  // 滚动模式不会分页，页数固定为 1
  pageCount.value = 1
  emitReady()
}

/** 滚动模式定位到当前章节 */
async function restoreScroll(percent = props.initialPercent): Promise<void> {
  await nextTick()
  const shell = shells.get(chapterIndex.value)
  if (!shell) return
  restoring = true
  scrollerRef.value?.scrollTo({ top: shell.offsetTop + shell.offsetHeight * percent })
  setTimeout(() => {
    restoring = false
  }, 120)
}

/** 重建当前视图（设置变化后调用） */
async function rebuild(): Promise<void> {
  if (props.settings.mode === 'scroll') {
    const targets = Array.from(mountedChapters)
    for (const index of targets) {
      const shell = shells.get(index)
      if (!shell) continue
      const root = mountChapter(shell, props.doc.chapters[index], bookCss.value)
      await waitImages(root)
      applyChapterNotes(root, index)
    }
    return
  }
  await renderPaged(true)
}

/** 初始化 */
onMounted(async () => {
  if (props.settings.mode === 'scroll') {
    await setupScroll()
    await restoreScroll()
    return
  }

  await renderPaged(false)
  resizeObserver = new ResizeObserver(() => {
    void renderPaged(true)
  })
  if (stageRef.value) resizeObserver.observe(stageRef.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  resizeObserver?.disconnect()
  observer = null
  resizeObserver = null
  shells.clear()
  mountedChapters.clear()
})

// 阅读模式切换：重建视图
watch(
  () => props.settings.mode,
  async (mode) => {
    await nextTick()
    if (mode === 'scroll') {
      await setupScroll()
      await restoreScroll(0)
      return
    }
    observer?.disconnect()
    observer = null
    mountedChapters.clear()
    await renderPaged(false)
  },
)

// 排版设置变化：保持相对位置重建
watch(
  () => [props.settings.fontSize, props.settings.lineHeight, props.settings.fontFamily, props.settings.padding, props.settings.theme],
  async () => {
    await nextTick()
    await rebuild()
  },
)

// 笔记变化：仅重绘高亮
watch(
  () => props.notes,
  () => {
    const root = currentShadow()
    if (!root) return
    clearNotes(root)
    applyChapterNotes(root, chapterIndex.value)
  },
  { deep: true },
)

defineExpose({ next, prev, goToChapter, markSpeech, getParagraphs, chapterTextLength })
</script>

<style scoped>
.flow-reader {
  position: relative;
  height: 100%;
  width: 100%;
  overflow: hidden;
}

.stage {
  position: relative;
  height: 100%;
  padding: 0 var(--reader-padding, 48px);
  overflow: hidden;
}

/* 纸面：背景与内边距在这里，尺寸固定不动 */
.page-frame {
  box-sizing: content-box;
  margin: 0 auto;
  padding: 26px 32px;
  background: var(--rd-paper, #fff);
  box-shadow: var(--shadow-s);
}

.page-host {
  /* 显式声明 block：分页容器是 shadow host，若被解析为 inline 会导致 margin:auto 失效、正文贴左 */
  display: block;
  /* 裁剪窗口：位移发生在 Shadow DOM 内的 .book 上，窗口本身不动 */
  overflow: hidden;
}

.scroller {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 24px var(--reader-padding, 48px) 40vh;
  scroll-behavior: smooth;
}

.scroll-chapter {
  /* 内边距 32px，故 max-width 加上两侧内边距，保证正文字宽与分页模式一致 */
  max-width: calc(var(--reader-column, 820px) + 64px);
  margin: 0 auto;
  padding: 0 32px;
  background: var(--rd-paper, #fff);
  box-shadow: var(--shadow-s);
}

.scroll-tail {
  height: 24px;
}

.edge {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 12%;
  max-width: 120px;
  background: transparent;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 2;
}

.stage:hover .edge {
  opacity: 1;
}

.edge-left {
  left: 0;
  cursor: w-resize;
}

.edge-right {
  right: 0;
  cursor: e-resize;
}

/* 翻页按钮：边缘点击区是隐形的，必须再给一个看得见的入口 */
.pager {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 1px solid var(--c-border, rgba(20, 24, 32, 0.12));
  border-radius: 50%;
  background: var(--c-panel, #fff);
  color: var(--c-text-2, #5c6470);
  box-shadow: var(--shadow-s, 0 2px 10px rgba(20, 24, 32, 0.1));
  cursor: pointer;
  z-index: 3;
  transition: opacity 0.16s, color 0.16s, box-shadow 0.16s, transform 0.12s;
}

.pager:hover:not(:disabled) {
  color: var(--c-text, #1f2329);
  box-shadow: var(--shadow-m, 0 4px 16px rgba(20, 24, 32, 0.16));
}

.pager:active:not(:disabled) {
  transform: translateY(-50%) scale(0.94);
}

.pager:focus-visible {
  outline: 2px solid var(--c-accent, #4f7cff);
  outline-offset: 2px;
}

.pager:disabled {
  opacity: 0.25;
  cursor: default;
  box-shadow: none;
}

.pager-prev {
  left: 6px;
}

.pager-next {
  right: 6px;
}

@media (max-width: 720px) {
  .stage {
    padding: 0 var(--reader-padding-mobile, 20px);
  }

  .page-frame {
    padding: 16px 18px;
  }

  .scroller {
    padding: 16px var(--reader-padding-mobile, 20px) 40vh;
  }

  .scroll-chapter {
    padding: 0 18px;
  }
}
</style>
