<!-- 应用根组件：书架与阅读器切换、导入调度、全局提示 -->
<template>
  <div class="app" @dragover.prevent="onDragOver" @dragleave="onDragLeave" @drop.prevent="onDrop">
    <!-- 存储不可持久化 / 目录权限失效时的说明，并提供切换存储位置的入口 -->
    <div v-if="storageNotice && !currentBookId && !backupOpen" class="storage-warn">
      <AppIcon name="info" :size="15" />
      <span>{{ storageNoticeText }}</span>
      <button class="warn-action" @click="storageOpen = true">{{ t('storage.title') }}</button>
    </div>

    <Shelf
      v-if="!currentBookId"
      :books="books"
      :importing="importing"
      :import-text="importText"
      @open="openReader"
      @import="handleImport"
      @delete="handleDelete"
      @backup="backupOpen = true"
      @storage="storageOpen = true"
    />

    <Reader
      v-else
      :key="currentBookId"
      :book-id="currentBookId"
      @back="closeReader"
      @changed="refreshBooks"
      @toast="pushToast"
    />

    <!-- 拖拽导入遮罩 -->
    <transition name="fade">
      <div v-if="dragging" class="drop-mask">
        <div class="drop-card">
          <AppIcon name="upload" :size="30" :stroke-width="1.4" />
          <p>{{ t('shelf.import') }}</p>
          <span>EPUB · PDF · TXT · MOBI · AZW3 · CBZ …</span>
        </div>
      </div>
    </transition>

    <AppToast :items="toasts" />
    <BackupDialog v-if="!currentBookId" v-model="backupOpen" @toast="pushToast" @changed="refreshBooks" />
    <StorageDialog v-model="storageOpen" @toast="pushToast" @changed="onStorageChanged" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Shelf from './components/Shelf.vue'
import Reader from './components/Reader.vue'
import BackupDialog from './components/panels/BackupDialog.vue'
import StorageDialog from './components/panels/StorageDialog.vue'
import AppIcon from './components/ui/AppIcon.vue'
import AppToast, { type ToastItem } from './components/ui/AppToast.vue'
import { getStorageInfo, listBooks, type StorageInfo } from './core/db'
import { importFiles, removeBook } from './core/library'
import type { BookMeta } from './core/types'
import { t } from './i18n'

const books = ref<BookMeta[]>([])
const currentBookId = ref('')
const importing = ref(false)
const importText = ref('')
const dragging = ref(false)
const backupOpen = ref(false)
const toasts = ref<ToastItem[]>([])
/** 存储位置弹窗 */
const storageOpen = ref(false)
/** 当前存储状态（位置 / 是否持久 / 目录权限） */
const storageInfo = ref<StorageInfo>({
  mode: 'auto',
  active: 'memory',
  persistent: false,
  location: '',
  canPickDirectory: false,
  hasSidecar: false,
})
/** 是否需要提示用户处理存储位置 */
const storageNotice = computed(
  () => !storageInfo.value.persistent || Boolean(storageInfo.value.needsPermission),
)
/** 提示文案：优先提示目录授权问题 */
const storageNoticeText = computed(() =>
  storageInfo.value.needsPermission
    ? t('storage.needPermission')
    : t('app.storageEphemeral'),
)

let toastSeq = 0
let dragDepth = 0

/** 推送提示 */
function pushToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
  const id = ++toastSeq
  toasts.value.push({ id, text: message, type })
  setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id)
  }, 3600)
}

/** 刷新书架数据 */
async function refreshBooks(): Promise<void> {
  try {
    books.value = await listBooks()
  } catch (error) {
    pushToast(error instanceof Error ? error.message : '读取书架失败', 'error')
  }
}

/** 刷新存储状态 */
async function refreshStorageInfo(): Promise<void> {
  try {
    storageInfo.value = await getStorageInfo()
  } catch (error) {
    console.warn('[app] 读取存储状态失败', error)
  }
}

/** 存储位置变更后重新加载书架 */
async function onStorageChanged(): Promise<void> {
  await refreshStorageInfo()
  await refreshBooks()
}

/** 导入文件 */
async function handleImport(files: File[]): Promise<void> {
  if (!files.length || importing.value) return
  importing.value = true
  importText.value = t('shelf.importing', { name: files[0].name, current: 1, total: files.length })
  try {
    const result = await importFiles(files, (current, total, name) => {
      importText.value = t('shelf.importing', { name, current, total })
    })
    await refreshBooks()
    if (result.added.length) pushToast(t('toast.imported', { n: result.added.length }), 'success')
    if (result.skipped.length) pushToast(t('toast.skipped', { n: result.skipped.length }), 'info')
    if (result.failed.length) {
      pushToast(
        t('toast.failed', {
          n: result.failed.length,
          detail: `${result.failed[0].name}：${result.failed[0].reason}`,
        }),
        'error',
      )
    }
  } catch (error) {
    pushToast(error instanceof Error ? error.message : '导入失败', 'error')
  } finally {
    importing.value = false
    importText.value = ''
  }
}

/** 删除书籍 */
async function handleDelete(id: string): Promise<void> {
  try {
    await removeBook(id)
    await refreshBooks()
    pushToast(t('toast.deleted'), 'success')
  } catch (error) {
    pushToast(error instanceof Error ? error.message : '删除失败', 'error')
  }
}

/** 打开阅读器 */
function openReader(id: string): void {
  currentBookId.value = id
}

/** 返回书架 */
async function closeReader(): Promise<void> {
  currentBookId.value = ''
  await refreshBooks()
}

/* ===== 拖拽导入 ===== */

/** 拖入 */
function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return
  dragDepth += 1
  dragging.value = true
}

/** 拖离 */
function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

/** 释放 */
function onDrop(event: DragEvent): void {
  dragDepth = 0
  dragging.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  if (currentBookId.value) {
    pushToast('请先返回书架再导入新书', 'info')
    return
  }
  void handleImport(files)
}

onMounted(async () => {
  // 设置已在 bootstrap() 中载入（并已套用宿主语言/主题），此处不再重复载入，
  // 否则会用默认值覆盖宿主下发的 locale / appearance
  await refreshStorageInfo()
  await refreshBooks()
})
</script>

<style scoped>
.app {
  height: 100%;
  position: relative;
  overflow: hidden;
}

/* 非持久化存储说明条：底部浮层，避免挤压书架布局 */
.storage-warn {
  position: fixed;
  left: 50%;
  bottom: 88px;
  transform: translateX(-50%);
  z-index: 2250;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: min(94vw, 680px);
  padding: 9px 10px 9px 14px;
  border-radius: 14px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--c-text-2);
  background: color-mix(in srgb, var(--c-panel) 94%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-primary) 26%, var(--c-border));
  box-shadow: var(--shadow-m);
  backdrop-filter: blur(10px);
}

.storage-warn :deep(svg) {
  flex: none;
  color: var(--c-primary);
}

.warn-action {
  flex: none;
  height: 26px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--c-primary);
  background: var(--c-primary-soft);
  transition: background 0.16s;
}

.warn-action:hover {
  background: color-mix(in srgb, var(--c-primary) 18%, var(--c-primary-soft));
}

.drop-mask {
  position: fixed;
  inset: 0;
  z-index: 2600;
  background: rgba(79, 124, 255, 0.08);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.drop-card {
  width: min(420px, 84vw);
  padding: 40px 24px;
  border: 2px dashed var(--c-primary);
  border-radius: var(--radius-l);
  background: color-mix(in srgb, var(--c-panel) 92%, transparent);
  text-align: center;
  color: var(--c-primary);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.drop-card p {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.drop-card span {
  font-size: 11px;
  color: var(--c-text-3);
}
</style>
