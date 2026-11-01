<!-- 书架：导入、检索、排序、打开与删除 -->
<template>
  <section class="shelf">
    <header class="topbar">
      <div class="brand">
        <div class="logo">
          <AppIcon name="book" :size="20" />
        </div>
        <div class="brand-text">
          <h1>{{ t('app.name') }}</h1>
          <span>{{ t('shelf.count', { n: books.length }) }}</span>
        </div>
      </div>

      <div class="tools">
        <label class="search">
          <AppIcon name="search" :size="16" />
          <input v-model="keyword" type="search" :placeholder="t('shelf.search')" />
        </label>

        <select v-model="sortBy" class="sort" :title="t('shelf.sort.recent')">
          <option value="recent">{{ t('shelf.sort.recent') }}</option>
          <option value="added">{{ t('shelf.sort.added') }}</option>
          <option value="title">{{ t('shelf.sort.title') }}</option>
          <option value="author">{{ t('shelf.sort.author') }}</option>
        </select>

        <button class="btn btn-ghost btn-storage" :title="t('storage.title')" @click="emit('storage')">
          <AppIcon name="download" :size="16" />
          {{ t('storage.title') }}
        </button>

        <button class="btn btn-ghost btn-backup" @click="emit('backup')">
          <AppIcon name="cloud" :size="16" />
          {{ t('shelf.backup') }}
        </button>

        <button class="btn btn-primary" :disabled="importing" @click="pickFiles">
          <AppIcon name="plus" :size="16" />
          {{ t('shelf.import') }}
        </button>
      </div>
    </header>

    <div v-if="importing" class="import-bar">
      <span class="spinner" />
      <span>{{ importText }}</span>
    </div>

    <div class="content">
      <div v-if="!books.length" class="empty">
        <div class="empty-icon">
          <AppIcon name="library" :size="40" :stroke-width="1.2" />
        </div>
        <h2>{{ t('shelf.empty.title') }}</h2>
        <p>{{ t('shelf.empty.desc') }}</p>
        <button class="btn btn-primary" @click="pickFiles">
          <AppIcon name="plus" :size="16" />
          {{ t('shelf.empty.action') }}
        </button>

        <div class="formats">
          <span class="formats-title">{{ t('shelf.formats') }}</span>
          <div class="format-groups">
            <div v-for="group in FORMAT_GROUPS" :key="group.label" class="format-group">
              <span class="group-label">{{ group.label }}</span>
              <span v-for="format in group.formats" :key="format" class="chip">{{ format }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="!visibleBooks.length" class="no-result">
        <AppIcon name="search" :size="28" :stroke-width="1.2" />
        <p>{{ t('shelf.noResult') }}</p>
      </div>

      <div v-else class="grid">
        <article
          v-for="book in visibleBooks"
          :key="book.id"
          class="card"
          tabindex="0"
          @click="emit('open', book.id)"
          @keydown.enter="emit('open', book.id)"
        >
          <div class="cover">
            <img v-if="book.cover" :src="book.cover" :alt="book.title" loading="lazy" />
            <div v-else class="cover-fallback">
              <span v-if="hasCjk(book.title)" class="initials">{{ book.title.slice(0, 2) }}</span>
              <AppIcon v-else name="book" :size="30" :stroke-width="1.3" />
            </div>
            <span class="badge">{{ book.format.toUpperCase() }}</span>
            <div class="progress-rail">
              <div class="progress-fill" :style="{ width: `${progressOf(book)}%` }" />
            </div>
          </div>

          <div class="meta">
            <h3 :title="book.title">{{ book.title }}</h3>
            <p class="author">{{ book.author || '—' }}</p>
            <div class="sub">
              <span>{{ progressLabel(book) }}</span>
              <button class="del" :title="t('common.delete')" @click.stop="askDelete(book)">
                <AppIcon name="trash" :size="15" />
              </button>
            </div>
          </div>
        </article>
      </div>
    </div>

    <input
      ref="fileInput"
      type="file"
      multiple
      class="hidden-input"
      :accept="acceptAttribute()"
      @change="onFilesPicked"
    />

    <ConfirmDialog
      v-model="deleteDialog"
      :title="t('shelf.delete.title')"
      :description="t('shelf.delete.desc', { title: pendingDelete?.title ?? '' })"
      :confirm-text="t('common.delete')"
      :loading="deleting"
      @confirm="confirmDelete"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from './ui/AppIcon.vue'
import ConfirmDialog from './ui/ConfirmDialog.vue'
import { acceptAttribute } from '../core/library'
import { FORMAT_GROUPS } from '../core/parsers'
import type { BookMeta } from '../core/types'
import { t } from '../i18n'

const props = defineProps<{
  books: BookMeta[]
  importing: boolean
  importText: string
}>()

const emit = defineEmits<{
  (event: 'open', id: string): void
  (event: 'import', files: File[]): void
  (event: 'delete', id: string): void
  (event: 'backup'): void
  (event: 'storage'): void
}>()

const keyword = ref('')
const sortBy = ref<'recent' | 'added' | 'title' | 'author'>('recent')
const fileInput = ref<HTMLInputElement | null>(null)
const deleteDialog = ref(false)
const pendingDelete = ref<BookMeta | null>(null)
const deleting = ref(false)

/** 过滤 + 排序后的书籍列表 */
const visibleBooks = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  const filtered = query
    ? props.books.filter(
        (book) =>
          book.title.toLowerCase().includes(query) || book.author.toLowerCase().includes(query),
      )
    : [...props.books]

  return filtered.sort((a, b) => {
    switch (sortBy.value) {
      case 'title':
        return a.title.localeCompare(b.title, 'zh-CN')
      case 'author':
        return a.author.localeCompare(b.author, 'zh-CN')
      case 'added':
        return b.addedAt - a.addedAt
      default:
        // 最近阅读优先，未读排在后面
        return (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt)
    }
  })
})

/** 标题是否包含中日韩字符（用于决定占位封面展示文字还是图标） */
const hasCjk = (title: string): boolean => /[\u4e00-\u9fa5]/.test(title)

/** 阅读进度百分比 */
const progressOf = (book: BookMeta): number => Math.round((book.progress?.bookPercent ?? 0) * 100)

/** 进度文案 */
const progressLabel = (book: BookMeta): string => {
  const percent = progressOf(book)
  return percent > 0 ? t('shelf.progress', { n: percent }) : t('shelf.unread')
}

/** 打开文件选择框 */
const pickFiles = () => {
  // 先清空 value，保证可以重复选择同一文件；
  // 不能在读取过程中清空，否则 Chromium 会回收 File 引用导致读取失败（NotReadableError）
  if (fileInput.value) fileInput.value.value = ''
  fileInput.value?.click()
}

/** 文件选择回调 */
const onFilesPicked = (event: Event) => {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) emit('import', files)
}

/** 请求删除（触发二次确认） */
const askDelete = (book: BookMeta) => {
  pendingDelete.value = book
  deleteDialog.value = true
}

/** 确认删除 */
const confirmDelete = async () => {
  if (!pendingDelete.value) return
  deleting.value = true
  try {
    emit('delete', pendingDelete.value.id)
    deleteDialog.value = false
  } finally {
    deleting.value = false
    pendingDelete.value = null
  }
}
</script>

<style scoped>
.shelf {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
}

.topbar {
  height: var(--header-h);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: color-mix(in srgb, var(--c-panel) 86%, transparent);
  border-bottom: 1px solid var(--c-border);
  backdrop-filter: saturate(1.6) blur(12px);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: linear-gradient(135deg, #4f7cff, #7a5cf0);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-text h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
}

.brand-text span {
  font-size: 11px;
  color: var(--c-text-3);
}

.tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  color: var(--c-text-3);
  transition: border-color 0.16s, box-shadow 0.16s;
}

.search:focus-within {
  border-color: var(--c-primary);
  box-shadow: 0 0 0 3px rgba(79, 124, 255, 0.12);
}

.search input {
  border: none;
  box-shadow: none;
  padding: 0;
  width: 180px;
  background: transparent;
}

.search input:focus {
  box-shadow: none;
}

.sort {
  height: 34px;
  padding: 0 8px;
  border-radius: var(--radius-m);
  color: var(--c-text-2);
}

.import-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 24px;
  font-size: 12px;
  color: var(--c-primary);
  background: var(--c-primary-soft);
  border-bottom: 1px solid #dfe8ff;
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(79, 124, 255, 0.25);
  border-top-color: var(--c-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 22px 20px;
}

.card {
  cursor: pointer;
  outline: none;
}

.card:hover .cover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-m);
}

.cover {
  position: relative;
  aspect-ratio: 3 / 4.2;
  border-radius: var(--radius-m);
  overflow: hidden;
  background: #e9edf4;
  box-shadow: var(--shadow-s);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(150deg, #e6ecfa, #efe7fb);
  color: #6b7c9e;
  padding: 0 8px;
  text-align: center;
}

.initials {
  font-family: 'Songti SC', 'Noto Serif SC', serif;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: 3px;
}

.badge {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: #fff;
  background: rgba(20, 24, 32, 0.55);
  border-radius: 4px;
  backdrop-filter: blur(4px);
}

.progress-rail {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.35);
}

.progress-fill {
  height: 100%;
  background: var(--c-primary);
  transition: width 0.3s;
}

.meta {
  padding: 10px 2px 0;
}

.meta h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--c-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.author {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--c-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub {
  margin-top: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--c-text-3);
}

.del {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-3);
  opacity: 0;
  transition: opacity 0.16s, color 0.16s, background 0.16s;
}

.card:hover .del {
  opacity: 1;
}

.del:hover {
  color: var(--c-danger);
  background: rgba(229, 72, 77, 0.08);
}

.empty {
  max-width: 560px;
  margin: 8vh auto 0;
  text-align: center;
}

.empty-icon {
  width: 84px;
  height: 84px;
  border-radius: 24px;
  margin: 0 auto 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--c-panel);
  color: var(--c-primary);
  box-shadow: var(--shadow-s);
}

.empty h2 {
  margin: 0 0 8px;
  font-size: 18px;
}

.empty p {
  margin: 0 0 20px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--c-text-3);
}

.formats {
  margin-top: 40px;
  text-align: left;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-l);
  padding: 16px 18px;
}

.formats-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-2);
}

.format-groups {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.format-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.group-label {
  width: 84px;
  font-size: 11px;
  color: var(--c-text-3);
}

.chip {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--c-text-2);
  background: var(--c-subtle);
  border-radius: 4px;
  padding: 2px 6px;
}

.no-result {
  margin-top: 12vh;
  text-align: center;
  color: var(--c-text-3);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.hidden-input {
  display: none;
}

@media (max-width: 720px) {
  .topbar {
    padding: 0 14px;
    gap: 8px;
  }

  .search input {
    width: 96px;
  }

  .btn span,
  .tools .btn-ghost {
    display: none;
  }

  .content {
    padding: 16px;
  }

  .grid {
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 16px 12px;
  }
}
</style>
