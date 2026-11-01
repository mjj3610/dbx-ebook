<!-- 选中文字后的浮动操作条：四色高亮、批注、翻译、复制 -->
<template>
  <teleport to="body">
    <transition name="fade">
      <div v-if="visible" ref="barRef" class="bar" :style="positionStyle" @mousedown.prevent>
        <button
          v-for="(value, key) in NOTE_COLORS"
          :key="key"
          class="dot"
          :style="{ background: value.border }"
          :title="`${t('notes.highlight')} · ${value.label}`"
          @click="emit('highlight', key)"
        />
        <span class="divider" />
        <button class="act" @click="emit('note')">
          <AppIcon name="note" :size="15" />
          {{ t('notes.comment') }}
        </button>
        <button class="act" @click="emit('translate')">
          <AppIcon name="translate" :size="15" />
          {{ t('reader.translate') }}
        </button>
        <button class="act" @click="emit('copy')">
          <AppIcon name="text" :size="15" />
          {{ t('common.copy') }}
        </button>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from './ui/AppIcon.vue'
import { NOTE_COLORS } from '../core/constants'
import type { NoteColor } from '../core/types'
import { t } from '../i18n'

const props = defineProps<{
  visible: boolean
  /** 选区矩形（视口坐标） */
  rect: DOMRect | null
}>()

const emit = defineEmits<{
  (event: 'highlight', color: NoteColor): void
  (event: 'note'): void
  (event: 'translate'): void
  (event: 'copy'): void
}>()

const barRef = ref<HTMLElement | null>(null)
const size = ref({ width: 320, height: 40 })

/** 计算浮层位置：优先在选区上方，空间不足时放到下方 */
const positionStyle = computed(() => {
  const rect = props.rect
  if (!rect) return { display: 'none' }
  const gap = 8
  const width = size.value.width
  const height = size.value.height
  const centered = rect.left + rect.width / 2 - width / 2
  const left = Math.min(Math.max(centered, 8), window.innerWidth - width - 8)
  const above = rect.top - height - gap
  const top = above > 8 ? above : rect.bottom + gap
  return {
    left: `${left}px`,
    top: `${Math.min(top, window.innerHeight - height - 8)}px`,
  }
})

// 显示后测量真实尺寸，避免越界
watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return
    await nextTick()
    const el = barRef.value
    if (!el) return
    size.value = { width: el.offsetWidth, height: el.offsetHeight }
  },
)
</script>

<style scoped>
.bar {
  position: fixed;
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  box-shadow: var(--shadow-m);
  user-select: none;
}

.dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  margin: 0 2px;
  border: 2px solid transparent;
  transition: transform 0.14s, border-color 0.14s;
}

.dot:hover {
  transform: scale(1.15);
  border-color: rgba(0, 0, 0, 0.12);
}

.divider {
  width: 1px;
  height: 18px;
  background: var(--c-border);
  margin: 0 4px;
}

.act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--c-text-2);
}

.act:hover {
  background: var(--c-hover);
  color: var(--c-primary);
}
</style>
