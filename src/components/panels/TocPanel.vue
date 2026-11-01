<!-- 目录面板：支持搜索过滤与层级缩进 -->
<template>
  <transition name="slide">
    <aside v-if="open" class="panel">
      <header class="panel-head">
        <h3>{{ t('reader.toc') }}</h3>
        <button class="icon-btn" @click="emit('close')"><AppIcon name="close" /></button>
      </header>

      <label class="search">
        <AppIcon name="search" :size="15" />
        <input v-model="keyword" type="search" :placeholder="t('shelf.search')" />
      </label>

      <ul class="toc-list">
        <li
          v-for="(item, index) in filtered"
          :key="`${item.chapterIndex}-${index}`"
          class="toc-item"
          :class="{ active: item.chapterIndex === currentChapter }"
          :style="{ paddingLeft: `${12 + item.level * 14}px` }"
          @click="onSelect(item.chapterIndex)"
        >
          <span class="title">{{ item.title }}</span>
        </li>
        <li v-if="!filtered.length" class="empty">{{ t('shelf.noResult') }}</li>
      </ul>
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import type { TocItem } from '../../core/types'
import { t } from '../../i18n'

const props = defineProps<{
  open: boolean
  toc: TocItem[]
  currentChapter: number
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'select', chapterIndex: number): void
}>()

const keyword = ref('')

/** 过滤后的目录项 */
const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return props.toc
  return props.toc.filter((item) => item.title.toLowerCase().includes(query))
})

/** 选中目录项 */
const onSelect = (chapterIndex: number) => {
  emit('select', chapterIndex)
  emit('close')
}
</script>

<style scoped>
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(340px, 84vw);
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
  padding: 0 12px 0 18px;
  border-bottom: 1px solid var(--c-border);
}

.panel-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.search {
  margin: 12px 14px 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 32px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  color: var(--c-text-3);
}

.search input {
  border: none;
  box-shadow: none;
  padding: 0;
  flex: 1;
  background: transparent;
}

.search input:focus {
  box-shadow: none;
}

.toc-list {
  list-style: none;
  margin: 0;
  padding: 6px 8px 20px;
  overflow-y: auto;
  flex: 1;
}

.toc-item {
  padding: 9px 12px;
  border-radius: var(--radius-s);
  cursor: pointer;
  font-size: 13px;
  line-height: 1.5;
  color: var(--c-text-2);
  transition: background 0.14s, color 0.14s;
}

.toc-item:hover {
  background: var(--c-hover);
  color: var(--c-text);
}

.toc-item.active {
  background: var(--c-primary-soft);
  color: var(--c-primary);
  font-weight: 500;
}

.title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--c-text-3);
}
</style>
