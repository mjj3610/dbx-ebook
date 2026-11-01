<!-- 备份与同步：本地导出/导入 + WebDAV 网盘 -->
<template>
  <teleport to="body">
    <transition name="fade">
      <div v-if="modelValue" class="mask" @click.self="close">
        <div class="dialog">
          <header class="head">
            <h3>{{ t('backup.title') }}</h3>
            <button class="icon-btn" @click="close"><AppIcon name="close" /></button>
          </header>

          <div class="body">
            <!-- 本地备份 -->
            <section class="block">
              <h4>{{ t('backup.local') }}</h4>
              <p class="desc">{{ t('backup.localDesc') }}</p>
              <div class="actions">
                <button class="btn btn-ghost" :disabled="busy" @click="exportLocal(false)">
                  <AppIcon name="download" :size="15" />
                  {{ t('backup.exportData') }}
                </button>
                <button class="btn btn-ghost" :disabled="busy" @click="exportLocal(true)">
                  <AppIcon name="download" :size="15" />
                  {{ t('backup.exportFull') }}
                </button>
                <button class="btn btn-primary" :disabled="busy" @click="pickImport">
                  <AppIcon name="upload" :size="15" />
                  {{ t('backup.import') }}
                </button>
              </div>
            </section>

            <!-- WebDAV -->
            <section class="block">
              <h4>{{ t('backup.webdav') }}</h4>
              <p class="desc">{{ t('backup.webdavDesc') }}</p>

              <div class="form">
                <label class="field-row">
                  <span>{{ t('backup.url') }}</span>
                  <input v-model.trim="settings.webdav.url" placeholder="https://dav.jianguoyun.com/dav/ebook" />
                </label>
                <label class="field-row half">
                  <span>{{ t('backup.username') }}</span>
                  <input v-model.trim="settings.webdav.username" autocomplete="off" />
                </label>
                <label class="field-row half">
                  <span>{{ t('backup.password') }}</span>
                  <input v-model="settings.webdav.password" type="password" autocomplete="off" />
                </label>
                <label class="field-row">
                  <span>{{ t('backup.filename') }}</span>
                  <input v-model.trim="settings.webdav.filename" />
                </label>
                <label class="check">
                  <input v-model="settings.webdav.autoSync" type="checkbox" />
                  <span>{{ t('backup.autoSync') }}</span>
                </label>
              </div>

              <div class="actions">
                <button class="btn btn-ghost" :disabled="busy" @click="test">
                  <AppIcon name="refresh" :size="15" />
                  {{ t('backup.test') }}
                </button>
                <button class="btn btn-ghost" :disabled="busy" @click="upload">
                  <AppIcon name="cloud" :size="15" />
                  {{ t('backup.upload') }}
                </button>
                <button class="btn btn-ghost" :disabled="busy" @click="download">
                  <AppIcon name="download" :size="15" />
                  {{ t('backup.download') }}
                </button>
              </div>

              <p v-if="status" class="status" :class="statusType">{{ status }}</p>
            </section>
          </div>
        </div>
      </div>
    </transition>
  </teleport>

  <input ref="importInput" type="file" accept=".dbxebook,.zip,.json" class="hidden" @change="onImportPicked" />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import { describeBackup, downloadBlob, exportBackup, importBackup } from '../../core/backup'
import { persistWebdav, settings } from '../../core/settings'
import { downloadBackup, isWebdavConfigured, testWebdav, uploadBackup } from '../../core/webdav'
import { t } from '../../i18n'

const props = defineProps<{ modelValue: boolean }>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'toast', message: string, type?: 'info' | 'success' | 'error'): void
  (event: 'changed'): void
}>()

const importInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const status = ref('')
const statusType = ref<'info' | 'success' | 'error'>('info')

/** 关闭弹窗 */
const close = () => {
  persistWebdav()
  emit('update:modelValue', false)
}

/** 展示状态信息 */
const setStatus = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
  status.value = message
  statusType.value = type
  emit('toast', message, type === 'error' ? 'error' : 'success')
}

/** 导出本地备份 */
async function exportLocal(includeFiles: boolean): Promise<void> {
  busy.value = true
  status.value = ''
  try {
    const result = await exportBackup(includeFiles)
    downloadBlob(result.blob, result.filename)
    setStatus(
      t('backup.exported', { name: result.filename, size: describeBackup(result.blob) }),
      'success',
    )
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导出失败', 'error')
  } finally {
    busy.value = false
  }
}

/** 触发导入文件选择 */
const pickImport = () => importInput.value?.click()

/** 导入备份 */
async function onImportPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  status.value = t('backup.importing')
  try {
    const result = await importBackup(file)
    setStatus(t('backup.imported', { books: result.booksAdded, notes: result.notesAdded }), 'success')
    emit('changed')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导入失败', 'error')
  } finally {
    busy.value = false
  }
}

/** 测试连接 */
async function test(): Promise<void> {
  busy.value = true
  try {
    const message = await testWebdav()
    setStatus(message, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '连接失败', 'error')
  } finally {
    persistWebdav()
    busy.value = false
  }
}

/** 上传备份 */
async function upload(): Promise<void> {
  if (!isWebdavConfigured()) {
    setStatus(t('backup.needUrl'), 'error')
    return
  }
  busy.value = true
  try {
    persistWebdav()
    const result = await exportBackup(true)
    const message = await uploadBackup(result.blob)
    setStatus(message, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '上传失败', 'error')
  } finally {
    busy.value = false
  }
}

/** 下载并恢复 */
async function download(): Promise<void> {
  if (!isWebdavConfigured()) {
    setStatus(t('backup.needUrl'), 'error')
    return
  }
  busy.value = true
  try {
    persistWebdav()
    const file = await downloadBackup()
    const result = await importBackup(file)
    setStatus(t('backup.imported', { books: result.booksAdded, notes: result.notesAdded }), 'success')
    emit('changed')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '下载失败', 'error')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(18, 22, 30, 0.36);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2300;
  backdrop-filter: blur(2px);
}

.dialog {
  width: min(620px, 94vw);
  max-height: 86vh;
  background: var(--c-panel);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-l);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.head {
  height: 50px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 0 20px;
  border-bottom: 1px solid var(--c-border);
}

.head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 20px 20px;
}

.block {
  padding: 14px 0;
  border-bottom: 1px solid var(--c-border);
}

.block:last-child {
  border-bottom: none;
}

.block h4 {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.desc {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--c-text-3);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}

.field-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 100%;
}

.field-row.half {
  flex: 1 1 calc(50% - 5px);
}

.field-row span {
  font-size: 11px;
  color: var(--c-text-3);
}

.field-row input {
  width: 100%;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--c-text-2);
}

.status {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.6;
}

.status.success {
  color: var(--c-success);
}

.status.error {
  color: var(--c-danger);
}

.hidden {
  display: none;
}
</style>
