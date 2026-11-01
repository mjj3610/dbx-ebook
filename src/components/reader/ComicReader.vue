<!-- 漫画阅读器：CBZ / CBT 图集，支持单页、双页与滚动 -->
<template>
  <div ref="rootRef" class="comic-reader" :class="`mode-${settings.mode}`">
    <div v-if="settings.mode === 'scroll'" class="comic-scroll">
      <img
        v-for="(page, index) in pages"
        :key="page.name"
        :src="page.url"
        :alt="page.name"
        class="comic-img-scroll"
        loading="lazy"
        @load="onScrollImageLoad"
      />
      <div class="scroll-tail" />
    </div>

    <div v-else class="comic-stage" @click.self="next">
      <div class="comic-pages">
        <div v-for="index in visiblePages" :key="index" class="comic-page">
          <img :src="pages[index].url" :alt="pages[index].name" class="comic-img" />
        </div>
      </div>
      <button class="edge edge-left" @click="prev" />
      <button class="edge edge-right" @click="next" />
      <button class="pager pager-prev" :disabled="currentPage <= 0" :aria-label="t('reader.prev')" :title="t('reader.prev')" @click.stop="prev">
        <AppIcon name="chevronLeft" :size="22" />
      </button>
      <button
        class="pager pager-next"
        :disabled="currentPage >= pages.length - 1"
        :aria-label="t('reader.next')"
        :title="t('reader.next')"
        @click.stop="next"
      >
        <AppIcon name="chevronRight" :size="22" />
      </button>
    </div>

    <div class="comic-hint" v-if="settings.mode === 'scroll'">{{ pageLabel }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { BookDoc, ReaderSettings } from '../../core/types'
import { t } from '../../i18n'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{
  doc: BookDoc
  settings: ReaderSettings
  initialPage: number
}>()

const emit = defineEmits<{
  (event: 'progress', payload: { page: number; percent: number }): void
  (event: 'ready', payload: { page: number; paragraphs: string[] }): void
}>()

const rootRef = ref<HTMLElement | null>(null)
const pages = computed(() => props.doc.pages ?? [])
const currentPage = ref(Math.min(props.initialPage, Math.max(pages.value.length - 1, 0)))

/** 双页模式一次显示两页 */
const visiblePages = computed<number[]>(() => {
  if (props.settings.mode !== 'double') return [currentPage.value]
  const start = currentPage.value - (currentPage.value % 2)
  return [start, start + 1].filter((index) => index < pages.value.length)
})

/** 进度文案 */
const pageLabel = computed(() => `${currentPage.value + 1} / ${pages.value.length}`)

/** 上报进度 */
function report(): void {
  const total = Math.max(pages.value.length - 1, 1)
  emit('progress', { page: currentPage.value, percent: currentPage.value / total })
  emit('ready', { page: currentPage.value, paragraphs: [] })
}

/** 跳页 */
function goToPage(target: number): void {
  currentPage.value = Math.min(Math.max(target, 0), Math.max(pages.value.length - 1, 0))
  report()
}

/** 下一页 */
function next(): void {
  if (props.settings.mode === 'scroll') {
    rootRef.value?.scrollBy({ top: (rootRef.value?.clientHeight ?? 600) * 0.92, behavior: 'smooth' })
    return
  }
  goToPage(currentPage.value + (props.settings.mode === 'double' ? 2 : 1))
}

/** 上一页 */
function prev(): void {
  if (props.settings.mode === 'scroll') {
    rootRef.value?.scrollBy({ top: -(rootRef.value?.clientHeight ?? 600) * 0.92, behavior: 'smooth' })
    return
  }
  goToPage(currentPage.value - (props.settings.mode === 'double' ? 2 : 1))
}

/** 滚动模式：根据滚动位置更新页码 */
function onScrollImageLoad(): void {
  report()
}

onMounted(() => {
  report()
})

defineExpose({ next, prev, goToPage })
</script>

<style scoped>
.comic-reader {
  height: 100%;
  background: #14161b;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mode-scroll {
  overflow-y: auto;
  display: block;
}

.comic-scroll {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 0 0 60vh;
}

.comic-img-scroll {
  max-width: min(100%, 900px);
  height: auto;
  display: block;
}

.scroll-tail {
  height: 24px;
}

.comic-stage {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  overflow: hidden;
}

.comic-pages {
  display: flex;
  gap: 8px;
  height: 100%;
  align-items: center;
  justify-content: center;
}

.comic-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.comic-img {
  max-height: 100%;
  max-width: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}

.edge {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 14%;
  max-width: 140px;
  background: transparent;
  cursor: pointer;
  z-index: 2;
}

.edge-left {
  left: 0;
  cursor: w-resize;
}

.edge-right {
  right: 0;
  cursor: e-resize;
}

.comic-hint {
  position: fixed;
  right: 20px;
  bottom: 68px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.42);
  pointer-events: none;
}

/* 翻页按钮：深色背景上给一个看得见的出口 */
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
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 50%;
  background: rgba(28, 32, 40, 0.72);
  color: #fff;
  cursor: pointer;
  z-index: 6;
  transition: opacity 0.16s, background 0.16s, transform 0.12s;
}

.pager:hover:not(:disabled) {
  background: rgba(48, 54, 66, 0.9);
}

.pager:active:not(:disabled) {
  transform: translateY(-50%) scale(0.94);
}

.pager:focus-visible {
  outline: 2px solid rgba(120, 160, 255, 0.8);
  outline-offset: 2px;
}

.pager:disabled {
  opacity: 0.2;
  cursor: default;
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
</style>
