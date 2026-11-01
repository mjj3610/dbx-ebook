<!-- PDF 阅读器：画布渲染 + 透明文本层（支持选中、翻译、听书），支持单页 / 双页 / 滚动 -->
<template>
  <div class="pdf-reader" :class="`mode-${settings.mode}`">
    <div
      ref="rootRef"
      class="pages-viewport"
      @mouseup="onMouseUp"
      @touchend="onTouchEnd"
      @touchstart.passive="onTouchStart"
    >
      <div ref="containerRef" class="pages" :style="{ gap: `${pageGap}px` }">
        <div
          v-for="index in visiblePages"
          :key="index"
          :ref="(el) => setPageRef(el as HTMLElement | null, index)"
          class="page-shell"
          :data-index="index"
          :style="{ width: `${pageWidth}px`, height: `${pageHeight}px` }"
        >
          <div class="page-inner">
            <canvas class="page-canvas" />
            <div class="text-layer book" />
            <div v-if="pageErrors[index]" class="page-error">{{ pageErrors[index] }}</div>
          </div>
          <span class="page-no">{{ index + 1 }}</span>
        </div>
      </div>

      <!-- 整份文档打不开时的显式提示，避免只剩一片空白 -->
      <div v-if="docError" class="doc-error">{{ docError }}</div>
    </div>

    <!-- 内嵌字体映射坏了、自动改用系统字体时，告诉用户为什么字形不一样 -->
    <div v-if="compatMode && !compatDismissed" class="compat-hint">
      <span>{{ t('pdf.compatHint') }}</span>
      <button class="compat-close" :aria-label="t('common.close')" @click="compatDismissed = true">×</button>
    </div>

    <!-- 翻页：分页模式下给出看得见的入口，滚动模式靠滚轮/触控板 -->
    <template v-if="settings.mode !== 'scroll' && pageCount > 1">
      <button class="pager pager-prev" :disabled="currentPage <= 0" :aria-label="t('reader.prev')" :title="t('reader.prev')" @click.stop="prev">
        <AppIcon name="chevronLeft" :size="22" />
      </button>
      <button
        class="pager pager-next"
        :disabled="currentPage >= pageCount - 1"
        :aria-label="t('reader.next')"
        :title="t('reader.next')"
        @click.stop="next"
      >
        <AppIcon name="chevronRight" :size="22" />
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { openPdfWithAutoCompat } from '../../core/parsers/pdf'
import { wrapQuote, readSelection } from '../../core/render'
import type { BookDoc, NoteRecord, ReaderSettings } from '../../core/types'
import { t } from '../../i18n'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{
  doc: BookDoc
  settings: ReaderSettings
  notes: NoteRecord[]
  initialPage: number
  zoom: number
}>()

const emit = defineEmits<{
  (event: 'progress', payload: { page: number; percent: number }): void
  (event: 'selection', payload: { text: string; start: number; end: number; rect: DOMRect } | null): void
  (event: 'ready', payload: { page: number; paragraphs: string[] }): void
  (event: 'loaded', payload: { pageCount: number }): void
}>()

/** 页面间距 px（与 .pages 的 gap 保持一致） */
const pageGap = 16
/** .pages 的左右内边距 px（与 CSS `padding: 20px 24px 48px` 保持一致） */
const PAGE_PADDING_X = 24
/** 基础渲染宽度比例（配合 zoom 缩放） */
const BASE_SCALE = 1.35

const rootRef = ref<HTMLElement | null>(null)
const containerRef = ref<HTMLElement | null>(null)
/**
 * 视口宽度。必须做成响应式：直接读 rootRef.clientWidth 不是响应式的，
 * 窗口缩放后 perView / pageWidth 都不会重算，双页会一直停在初始判定上。
 */
const viewportWidth = ref(0)
const pageRefs = new Map<number, HTMLElement>()
const renderedPages = new Set<number>()

// pdf.js 实例含私有字段，必须用 shallowRef 存储，避免被 Vue 代理后丢失 this 绑定
const pdfDoc = shallowRef<PDFDocumentProxy | null>(null)
const pageCount = ref(props.doc.pageCount ?? 0)
const currentPage = ref(0)
const pageWidth = ref(600)
const pageHeight = ref(800)
const pageTexts = ref<Map<number, string[]>>(new Map())
/** 单页渲染失败的原因，按页号记录；失败页会显示提示而不是留一片空白 */
const pageErrors = ref<Record<number, string>>({})
/** 整个文档打不开时的原因 */
const docError = ref('')
/** 该文档的内嵌字体无法正确映射，已改用系统字体渲染 */
const compatMode = ref(false)
const compatDismissed = ref(false)

let observer: IntersectionObserver | null = null
let resizeObserver: ResizeObserver | null = null

/** 双页模式每页至少要有这么宽，否则退回单页 */
const MIN_DOUBLE_PAGE_WIDTH = 320

/** 双页时两页加上间距与左右内边距后需要占的总宽 */
const DOUBLE_MIN_TOTAL = MIN_DOUBLE_PAGE_WIDTH * 2 + pageGap + PAGE_PADDING_X * 2

/**
 * 双页模式在窄屏降级
 * 注意：不能用 pageWidth 判断 —— pageWidth 是按 perView 算出来的，二者互相依赖，
 * 结果就是「按单页算宽 → 两页放不下 → 退回单页」永远成立，双页形同摆设。
 * 这里只看容器宽度。
 */
const perView = computed(() => {
  if (props.settings.mode !== 'double') return 1
  if (!viewportWidth.value) return 1
  return viewportWidth.value >= DOUBLE_MIN_TOTAL ? 2 : 1
})

/** 当前可见页集合 */
const visiblePages = computed<number[]>(() => {
  if (props.settings.mode === 'scroll') {
    return Array.from({ length: pageCount.value }, (unused, index) => index)
  }
  const start = perView.value === 2 ? currentPage.value - (currentPage.value % 2) : currentPage.value
  return perView.value === 2 ? [start, start + 1].filter((index) => index < pageCount.value) : [start]
})

/** 记录页面节点；翻页后旧节点要清掉，否则会渲染到已经脱离文档的 canvas 上 */
function setPageRef(el: HTMLElement | null, index: number): void {
  if (el) pageRefs.set(index, el)
  else pageRefs.delete(index)
}

/** 载入文档 */
onMounted(async () => {
  // 先接管视口尺寸：perView 与页面宽度都依赖它，晚一步就会按 0 处理一次
  if (rootRef.value) {
    viewportWidth.value = rootRef.value.clientWidth
    resizeObserver = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? rootRef.value?.clientWidth ?? 0)
      // 竖向滚动条出现/消失会造成 1px 抖动，忽略掉避免反复重绘
      if (Math.abs(width - viewportWidth.value) < 2) return
      viewportWidth.value = width
    })
    resizeObserver.observe(rootRef.value)
  }
  if (!props.doc.pdfData) return
  try {
    const opened = await openPdfWithAutoCompat(props.doc.pdfData as ArrayBuffer)
    const doc = opened.doc
    compatMode.value = opened.compat
    pdfDoc.value = doc
    pageCount.value = doc.numPages
    currentPage.value = Math.min(props.initialPage, doc.numPages - 1)
    await computePageSize()
    await nextTick()
    await renderVisible()
    setupObserver()
    emit('loaded', { pageCount: doc.numPages })
    emit('progress', { page: currentPage.value, percent: percentOf(currentPage.value) })
  } catch (error) {
    console.error('[pdf] 载入失败', error)
    const reason = error instanceof Error ? error.message : String(error)
    docError.value = t('pdf.loadFailed', { reason })
  }
})

/** 根据首屏宽度计算页面尺寸 */
async function computePageSize(): Promise<void> {
  const doc = pdfDoc.value
  if (!doc) return
  const page = await doc.getPage(1)
  const baseViewport = page.getViewport({ scale: 1 })
  const containerWidth = viewportWidth.value || rootRef.value?.clientWidth || 900
  // 双页时必须把「间距 + 左右内边距」一起从可用宽度里扣掉，否则两页总宽会超出视口，
  // flex 换行会把第 2 页挤到下一行 —— 看起来就像双页模式只渲染了一页。
  const usable = containerWidth - PAGE_PADDING_X * 2
  const available = perView.value === 2 ? (usable - pageGap) / 2 : usable
  const targetWidth = Math.max(240, Math.min(available, baseViewport.width * BASE_SCALE))
  const scale = (targetWidth / baseViewport.width) * props.zoom
  const viewport = page.getViewport({ scale })
  pageWidth.value = Math.round(viewport.width)
  pageHeight.value = Math.round(viewport.height)
}

/** 渲染指定页；失败时在页面上给出原因，而不是留一片空白让人以为是乱码 */
async function renderPage(index: number): Promise<void> {
  const doc = pdfDoc.value
  const shell = pageRefs.get(index)
  if (!doc || !shell) return
  const canvas = shell.querySelector('canvas') as HTMLCanvasElement | null
  const layer = shell.querySelector('.text-layer') as HTMLElement | null
  if (!canvas || !layer) return

  try {
    await drawPage(index, doc, canvas, layer)
    if (pageErrors.value[index]) {
      const next = { ...pageErrors.value }
      delete next[index]
      pageErrors.value = next
    }
  } catch (error) {
    console.error(`[pdf] 第 ${index + 1} 页渲染失败`, error)
    // 标记为已尝试，避免 IntersectionObserver 反复重试同一页造成卡顿
    renderedPages.add(index)
    pageErrors.value = {
      ...pageErrors.value,
      [index]: t('pdf.pageFailed', { reason: error instanceof Error ? error.message : String(error) }),
    }
  }
}

/** 真正把一页画到画布上并生成文本层 */
async function drawPage(index: number, doc: PDFDocumentProxy, canvas: HTMLCanvasElement, layer: HTMLElement): Promise<void> {
  const page: PDFPageProxy = await doc.getPage(index + 1)
  const baseViewport = page.getViewport({ scale: 1 })
  const scale = (pageWidth.value / baseViewport.width) * props.zoom
  const viewport = page.getViewport({ scale })

  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  canvas.style.width = `${Math.floor(viewport.width)}px`
  canvas.style.height = `${Math.floor(viewport.height)}px`

  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.fillStyle = '#fff'
  context.fillRect(0, 0, viewport.width, viewport.height)
  await page.render({ canvasContext: context, viewport }).promise

  // 透明文本层：用于选中、复制与高亮定位
  const textContent = await page.getTextContent()
  layer.innerHTML = ''
  layer.style.width = `${Math.floor(viewport.width)}px`
  layer.style.height = `${Math.floor(viewport.height)}px`
  const paragraphs: string[] = []
  let lineBuffer: string[] = []
  let itemIndex = 0

  for (const item of textContent.items) {
    if (!('str' in item)) continue
    const style = textContent.styles[item.fontName]
    const transform = multiply(viewport.transform, item.transform)
    const fontHeight = Math.hypot(transform[2], transform[3]) || 12
    const span = document.createElement('span')
    span.textContent = item.str
    span.dataset.p = String(itemIndex)
    span.style.left = `${transform[4]}px`
    span.style.top = `${transform[5] - fontHeight}px`
    span.style.fontSize = `${fontHeight}px`
    span.style.fontFamily = style?.fontFamily ?? 'sans-serif'
    layer.appendChild(span)

    if (item.str.trim()) lineBuffer.push(item.str)
    if (item.hasEOL) {
      const line = lineBuffer.join('').replace(/\s+/g, ' ').trim()
      if (line) paragraphs.push(line)
      lineBuffer = []
      itemIndex += 1
    }
  }
  pageTexts.value.set(index, paragraphs)
  applyPageNotes(index, layer)
  renderedPages.add(index)
}

/** 矩阵乘法（pdf.js 的 6 元仿射矩阵） */
function multiply(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

/** 应用该页高亮 */
function applyPageNotes(index: number, layer: HTMLElement): void {
  props.notes
    .filter((note) => note.chapterIndex === index)
    .forEach((note) => {
      wrapQuote(layer, note.text, note.color, note.id)
    })
}

/** 渲染可见页 */
async function renderVisible(): Promise<void> {
  for (const index of visiblePages.value) {
    if (props.settings.mode !== 'scroll' && renderedPages.has(index)) continue
    await renderPage(index)
  }
  emitReady()
}

/** 滚动模式懒加载 */
function setupObserver(): void {
  observer?.disconnect()
  if (props.settings.mode !== 'scroll') return
  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        const index = Number((entry.target as HTMLElement).dataset.index ?? '0')
        if (renderedPages.has(index)) return
        void renderPage(index)
      })
    },
    { root: rootRef.value, rootMargin: '600px 0px' },
  )
  pageRefs.forEach((el) => observer?.observe(el))
}

/** 当前页百分比 */
function percentOf(page: number): number {
  return pageCount.value ? page / Math.max(pageCount.value - 1, 1) : 0
}

/** 阅读进度上报 */
function emitReady(): void {
  const paragraphs = pageTexts.value.get(currentPage.value) ?? []
  emit('ready', { page: currentPage.value, paragraphs })
}

/** 翻页 */
async function goToPage(target: number): Promise<void> {
  const next = Math.min(Math.max(target, 0), Math.max(pageCount.value - 1, 0))
  currentPage.value = next
  if (props.settings.mode === 'scroll') {
    const shell = pageRefs.get(next)
    shell?.scrollIntoView({ block: 'start', behavior: 'auto' })
  } else {
    renderedPages.clear()
    await nextTick()
    await renderVisible()
  }
  emit('progress', { page: next, percent: percentOf(next) })
  emitReady()
}

/** 下一页 */
function next(): void {
  if (props.settings.mode === 'scroll') {
    rootRef.value?.scrollBy({ top: (rootRef.value?.clientHeight ?? 600) * 0.9, behavior: 'smooth' })
    return
  }
  void goToPage(currentPage.value + perView.value)
}

/** 上一页 */
function prev(): void {
  if (props.settings.mode === 'scroll') {
    rootRef.value?.scrollBy({ top: -(rootRef.value?.clientHeight ?? 600) * 0.9, behavior: 'smooth' })
    return
  }
  void goToPage(currentPage.value - perView.value)
}

/** 触屏左右滑动翻页（移动端没有键盘，也不方便找按钮） */
let touchStart: { x: number; y: number } | null = null

function onTouchStart(event: TouchEvent): void {
  const touch = event.touches[0]
  touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null
}

function onTouchEnd(event: TouchEvent): void {
  const start = touchStart
  touchStart = null
  // 触摸结束时也要处理文本选区
  onMouseUp()
  if (!start || props.settings.mode === 'scroll') return
  const touch = event.changedTouches[0]
  if (!touch) return
  const dx = touch.clientX - start.x
  const dy = touch.clientY - start.y
  // 横向意图明显才翻页，避免和长按选词打架
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
  if (dx < 0) next()
  else prev()
}

/** 选中文本 */
function onMouseUp(): void {
  requestAnimationFrame(() => {
    const shell = pageRefs.get(currentPage.value)
    const layer = shell?.querySelector('.text-layer')
    if (!(layer instanceof HTMLElement)) return
    const result = readSelection(layer)
    if (!result || !result.text.trim()) {
      emit('selection', null)
      return
    }
    const selection = window.getSelection()
    const rect = selection && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : new DOMRect()
    emit('selection', { ...result, rect })
  })
}

/** 高亮朗读行 */
function markSpeech(blockIndex: number): void {
  const shell = pageRefs.get(currentPage.value)
  const layer = shell?.querySelector('.text-layer')
  if (!layer) return
  layer.querySelectorAll('.tts-active').forEach((el) => el.classList.remove('tts-active'))
  layer.querySelector(`[data-p="${blockIndex}"]`)?.classList.add('tts-active')
}

/** 当前页段落（听书用） */
function getParagraphs(): string[] {
  return pageTexts.value.get(currentPage.value) ?? []
}

/** 尺寸/排版变化后重算页面并重绘 */
async function relayout(): Promise<void> {
  if (!pdfDoc.value) return
  await nextTick()
  await computePageSize()
  renderedPages.clear()
  pageRefs.forEach((el) => {
    const layer = el.querySelector('.text-layer')
    if (layer) layer.innerHTML = ''
  })
  await nextTick()
  await renderVisible()
}

// 缩放或排版变化：重新计算尺寸并重绘
watch(() => [props.zoom, props.settings.mode, props.settings.theme], relayout)

// 视口宽度变化：双页判定与页面宽度都要跟着变
watch(viewportWidth, relayout)

// 笔记变化：重绘高亮
watch(
  () => props.notes,
  () => {
    pageRefs.forEach((el, index) => {
      const layer = el.querySelector('.text-layer') as HTMLElement | null
      if (!layer) return
      layer.querySelectorAll('mark[data-note-id]').forEach((mark) => {
        const parent = mark.parentNode
        if (!parent) return
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
        parent.removeChild(mark)
        parent.normalize()
      })
      applyPageNotes(index, layer)
    })
  },
  { deep: true },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  resizeObserver?.disconnect()
  resizeObserver = null
  pageRefs.clear()
  renderedPages.clear()
  pdfDoc.value?.destroy().catch(() => undefined)
})

defineExpose({ next, prev, goToPage, markSpeech, getParagraphs })
</script>

<style scoped>
.pdf-reader {
  position: relative;
  height: 100%;
  overflow: hidden;
  background: #e9ecf1;
}

.pages-viewport {
  height: 100%;
  overflow: auto;
}

.pages {
  display: flex;
  /* 分页模式最多两页并排，绝不能换行 —— 一换行第 2 页就跑到下一屏，
     用户看到的就是「双页只显示一页」。宽度不够时宁可横向滚动。 */
  flex-wrap: nowrap;
  justify-content: center;
  padding: 20px 24px 48px;
}

.mode-scroll .pages {
  flex-direction: column;
  align-items: center;
}

.page-shell {
  position: relative;
  background: #fff;
  box-shadow: 0 2px 14px rgba(24, 30, 44, 0.12);
  border-radius: 3px;
  overflow: hidden;
  flex: none;
}

.mode-double .page-shell {
  border-radius: 2px;
}

.page-inner {
  position: relative;
  width: 100%;
  height: 100%;
}

.page-canvas {
  display: block;
}

.text-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  opacity: 1;
  z-index: 1;
}

.text-layer :deep(span) {
  position: absolute;
  white-space: pre;
  color: transparent;
  transform-origin: 0 0;
  cursor: text;
}

.text-layer :deep(span)::selection {
  background: rgba(79, 124, 255, 0.32);
}

.text-layer :deep(span.tts-active) {
  background: rgba(255, 196, 0, 0.3);
  border-radius: 2px;
}

.text-layer :deep(mark[data-note-id]) {
  color: transparent;
  border-radius: 2px;
}

.page-no {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 10px;
  color: rgba(31, 35, 41, 0.32);
  pointer-events: none;
  z-index: 2;
}

/* 翻页按钮：分页模式下必须看得见，否则用户不知道能翻页 */
.pager {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid rgba(20, 24, 32, 0.12);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.94);
  color: #2b3038;
  box-shadow: 0 2px 12px rgba(20, 24, 32, 0.16);
  cursor: pointer;
  z-index: 6;
  transition: opacity 0.16s, box-shadow 0.16s, transform 0.12s;
}

.pager:hover:not(:disabled) {
  box-shadow: 0 4px 18px rgba(20, 24, 32, 0.24);
}

.pager:active:not(:disabled) {
  transform: translateY(-50%) scale(0.94);
}

.pager:focus-visible {
  outline: 2px solid rgba(79, 124, 255, 0.7);
  outline-offset: 2px;
}

.pager:disabled {
  opacity: 0.2;
  cursor: default;
  box-shadow: none;
}

.pager-prev {
  left: 12px;
}

.pager-next {
  right: 12px;
}

@media (max-width: 720px) {
  .pager {
    width: 34px;
    height: 34px;
  }

  .pager-prev {
    left: 6px;
  }

  .pager-next {
    right: 6px;
  }
}

/* 字体兼容模式提示：一条细带，不挡正文，可关闭 */
.compat-hint {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(92%, 720px);
  padding: 7px 10px 7px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: #6b5320;
  background: rgba(255, 247, 230, 0.97);
  border: 1px solid rgba(196, 150, 46, 0.35);
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(20, 24, 32, 0.12);
  z-index: 7;
}

.compat-close {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: inherit;
  background: transparent;
  border: none;
  cursor: pointer;
  opacity: 0.6;
}

.compat-close:hover {
  opacity: 1;
}

@media (max-width: 720px) {
  .compat-hint {
    font-size: 11px;
    padding: 6px 8px 6px 10px;
  }
}

/* 单页渲染失败：明确告诉用户哪一页、为什么，而不是留白 */
.page-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  font-size: 12.5px;
  line-height: 1.8;
  text-align: center;
  color: var(--c-danger, #c0392b);
  background: #fff;
  z-index: 3;
}

.doc-error {
  margin: 24px auto;
  max-width: 520px;
  padding: 16px 18px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--c-danger, #c0392b);
  background: #fff;
  border-radius: var(--radius-m, 8px);
  box-shadow: var(--shadow-s, 0 2px 10px rgba(0, 0, 0, 0.08));
}
</style>
