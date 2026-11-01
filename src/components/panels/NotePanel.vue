<!-- 高亮与笔记面板：按章节聚合展示，可跳转、删除与导出 -->
<template>
  <transition name="slide">
    <aside v-if="open" class="panel">
      <header class="panel-head">
        <h3>{{ t('notes.title') }}<span class="count">{{ t('notes.count', { n: notes.length }) }}</span></h3>
        <div class="head-actions">
          <button class="icon-btn" :title="t('notes.export')" :disabled="!notes.length" @click="emit('export')">
            <AppIcon name="download" />
          </button>
          <button class="icon-btn" @click="emit('close')"><AppIcon name="close" /></button>
        </div>
      </header>

      <div v-if="!notes.length" class="empty">
        <AppIcon name="highlight" :size="26" :stroke-width="1.4" />
        <p>{{ t('notes.empty') }}</p>
      </div>

      <div v-else class="note-list">
        <div v-for="group in grouped" :key="group.chapterIndex" class="group">
          <div class="group-head">{{ group.title }}</div>
          <article v-for="note in group.items" :key="note.id" class="note" @click="emit('select', note)">
            <div class="quote" :style="{ borderLeftColor: colorOf(note.color) }">
              {{ note.text }}
            </div>
            <p v-if="note.comment" class="comment">{{ note.comment }}</p>
            <div class="note-foot">
              <span class="time">{{ formatTime(note.createdAt) }}</span>
              <button class="del" :title="t('common.delete')" @click.stop="emit('delete', note.id)">
                <AppIcon name="trash" :size="14" />
              </button>
            </div>
          </article>
        </div>
      </div>
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import { NOTE_COLORS } from '../../core/constants'
import type { NoteColor, NoteRecord } from '../../core/types'
import { t } from '../../i18n'

const props = defineProps<{
  open: boolean
  notes: NoteRecord[]
  chapterTitles: string[]
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'select', note: NoteRecord): void
  (event: 'delete', id: string): void
  (event: 'export'): void
}>()

/** 按章节分组 */
const grouped = computed(() => {
  const map = new Map<number, NoteRecord[]>()
  props.notes.forEach((note) => {
    const list = map.get(note.chapterIndex) ?? []
    list.push(note)
    map.set(note.chapterIndex, list)
  })
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([chapterIndex, items]) => ({
      chapterIndex,
      title: props.chapterTitles[chapterIndex] || t('notes.chapter', { n: chapterIndex + 1 }),
      items: items.sort((a, b) => a.start - b.start),
    }))
})

/** 颜色映射 */
const colorOf = (color: NoteColor): string => NOTE_COLORS[color].border

/** 时间格式化 */
const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<style scoped>
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(360px, 86vw);
  background: var(--c-panel);
  border-left: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  z-index: 40;
  box-shadow: -8px 0 32px rgba(20, 26, 40, 0.08);
}

.panel-head {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 0 18px;
  border-bottom: 1px solid var(--c-border);
}

.panel-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.count {
  font-size: 11px;
  font-weight: 400;
  color: var(--c-text-3);
}

.head-actions {
  display: flex;
  gap: 2px;
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--c-text-3);
  padding: 0 30px;
  text-align: center;
}

.empty p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}

.note-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px 24px;
}

.group {
  margin-bottom: 16px;
}

.group-head {
  font-size: 11px;
  font-weight: 600;
  color: var(--c-text-3);
  margin-bottom: 8px;
  letter-spacing: 0.3px;
}

.note {
  background: var(--c-subtle);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.14s, background 0.14s;
}

.note:hover {
  border-color: #cfd8ea;
  background: var(--c-panel);
}

.quote {
  font-size: 13px;
  line-height: 1.65;
  color: var(--c-text);
  border-left: 3px solid #f0b429;
  padding-left: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.comment {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-text-2);
  background: var(--c-panel);
  border-radius: var(--radius-s);
  padding: 6px 8px;
}

.note-foot {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--c-text-3);
}

.del {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-3);
}

.del:hover {
  color: var(--c-danger);
  background: rgba(229, 72, 77, 0.08);
}
</style>
