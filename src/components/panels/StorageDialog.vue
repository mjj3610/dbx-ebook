<!-- 存储位置设置：自动 / 本地文件夹 / 仅本次会话 -->
<template>
  <teleport to="body">
    <transition name="fade">
      <div v-if="modelValue" class="mask" @click.self="close">
        <div class="dialog">
          <header class="head">
            <h3>{{ t('storage.title') }}</h3>
            <button class="icon-btn" @click="close"><AppIcon name="close" /></button>
          </header>

          <div class="body">
            <!-- 当前状态 -->
            <div class="current" :class="{ ephemeral: !info.persistent }">
              <div class="current-text">
                <span class="label">{{ t('storage.current') }}</span>
                <strong :title="info.rootPath || info.location">{{ info.rootPath || info.location }}</strong>
                <span v-if="info.rootPath && info.bookFileCount !== undefined" class="sub">
                  {{ t('storage.fileCount', { count: info.bookFileCount }) }}
                </span>
              </div>
              <span class="badge" :class="info.persistent ? 'ok' : 'warn'">
                {{ info.persistent ? t('storage.persistent') : t('storage.ephemeral') }}
              </span>
            </div>

            <!-- 本机磁盘路径（原生后端） -->
            <section v-if="info.active === 'sidecar'" class="path-box">
              <label class="path-label" for="storage-root">{{ t('storage.pathLabel') }}</label>
              <div class="path-row">
                <input
                  id="storage-root"
                  v-model="rootInput"
                  class="path-input"
                  spellcheck="false"
                  :placeholder="defaultRootHint"
                  @keydown.enter="saveRoot"
                />
              </div>
              <div class="path-actions">
                <button class="btn btn-ghost" :disabled="busy" @click="openPicker">
                  <AppIcon name="folder" :size="15" />
                  {{ t('storage.browse') }}
                </button>
                <span class="spacer" />
                <button
                  class="btn btn-primary"
                  :disabled="busy || !rootInput.trim() || rootInput.trim() === info.rootPath"
                  @click="saveRoot"
                >
                  {{ t('storage.pathSave') }}
                </button>
              </div>
              <div class="path-meta">
                <span class="path-default">{{ t('storage.pathDefault') }}：{{ defaultRootHint }}</span>
                <button v-if="!info.rootIsDefault" class="link" :disabled="busy" @click="resetRoot">
                  {{ t('storage.pathReset') }}
                </button>
              </div>
              <p class="path-hint">{{ t('storage.pathHint') }}</p>
            </section>

            <!-- 目录权限失效 -->
            <div v-if="info.needsPermission" class="notice">
              <span>{{ t('storage.needPermission') }}</span>
              <button class="btn btn-ghost" :disabled="busy" @click="reconnect">
                {{ t('storage.reconnect') }}
              </button>
            </div>

            <!-- 模式选择 -->
            <section class="modes">
              <button
                v-for="option in options"
                :key="option.value"
                class="mode"
                :class="{ active: activeCard === option.value && !info.needsPermission, disabled: option.disabled }"
                :disabled="busy || option.disabled"
                @click="select(option)"
              >
                <div class="mode-head">
                  <AppIcon :name="option.icon" :size="16" />
                  <span class="mode-title">{{ option.title }}</span>
                  <span v-if="option.disabled" class="tag">
                    {{ option.value === 'sidecar' ? sidecarLabel : blockedLabel }}
                  </span>
                </div>
                <p class="mode-desc">{{ option.desc }}</p>
                <span v-if="option.value === 'directory' && info.directoryName" class="mode-path">
                  {{ info.directoryName }}
                </span>
                <span v-else-if="option.value === 'sidecar' && info.rootPath" class="mode-path">
                  {{ info.rootPath }}
                </span>
              </button>
            </section>

            <div class="actions">
              <button
                v-if="info.canPickDirectory"
                class="btn btn-primary"
                :disabled="busy"
                @click="chooseFolder"
              >
                <AppIcon name="download" :size="15" />
                {{ info.directoryName ? t('storage.reselect') : t('storage.choose') }}
              </button>
              <span v-else class="hint">{{ blockedHint }}</span>
            </div>

            <p v-if="message" class="status" :class="failed ? 'error' : 'success'">{{ message }}</p>

            <p class="note">{{ t('storage.migrateNote') }}</p>
          </div>
        </div>
      </div>
    </transition>
  </teleport>

  <!-- 目录选择器：沙箱里用不了系统选择器，改由原生后端列目录 -->
  <DirPickerDialog
    v-model="pickerOpen"
    :start-path="rootInput || info.rootPath || info.dataDir || ''"
    @select="onPicked"
    @toast="(text, type) => emit('toast', text, type)"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import DirPickerDialog from './DirPickerDialog.vue'
import {
  changeSidecarRoot,
  getStorageInfo,
  reconnectDirectory,
  resetSidecarRoot,
  switchStorage,
  type StorageInfo,
  type StorageMode,
} from '../../core/db'
import { pickDirectory } from '../../core/fs'
import { t } from '../../i18n'

const props = defineProps<{ modelValue: boolean }>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'changed'): void
  (event: 'toast', message: string, type?: 'info' | 'success' | 'error'): void
}>()

const info = ref<StorageInfo>({
  mode: 'auto',
  active: 'memory',
  persistent: false,
  location: '',
  canPickDirectory: false,
  hasSidecar: false,
})

/**
 * 实际生效的模式卡片
 * 选「自动」时后端可能是原生磁盘（sidecar），此时要把高亮落在「本机磁盘」上，
 * 否则界面会误导用户以为数据还在浏览器里
 */
const activeCard = computed<StorageMode>(() => {
  if (info.value.mode === 'auto') return info.value.active === 'sidecar' ? 'sidecar' : 'auto'
  return info.value.mode
})

/** 路径输入框内容 */
const rootInput = ref('')
/** 默认书库路径提示（插件数据目录/library） */
const defaultRootHint = computed(() => (info.value.dataDir ? `${info.value.dataDir}/library` : '插件数据目录/library'))

const busy = ref(false)
const message = ref('')
const failed = ref(false)

interface ModeOption {
  value: StorageMode
  title: string
  desc: string
  icon: string
  disabled?: boolean
}

const options = computed<ModeOption[]>(() => [
  {
    value: 'sidecar',
    title: t('storage.modeSidecar'),
    desc: t('storage.modeSidecarDesc'),
    icon: 'download',
    disabled: !info.value.hasSidecar,
  },
  {
    value: 'auto',
    title: t('storage.modeAuto'),
    desc: t('storage.modeAutoDesc'),
    icon: 'library',
  },
  {
    value: 'directory',
    title: t('storage.modeDir'),
    desc: t('storage.modeDirDesc'),
    icon: 'cloud',
    disabled: !info.value.canPickDirectory,
  },
  {
    value: 'memory',
    title: t('storage.modeMemory'),
    desc: t('storage.modeMemoryDesc'),
    icon: 'refresh',
  },
])

/** 目录不可用的标签 */
const blockedLabel = computed(() =>
  info.value.directoryBlocked === 'sandboxed' ? t('storage.blockedSandboxed') : t('storage.unavailable'),
)
/** Sidecar 模式不可用的标签 */
const sidecarLabel = computed(() => t('storage.sidecarUnavailable'))
/** 目录不可用的说明 */
const blockedHint = computed(() =>
  info.value.directoryBlocked === 'sandboxed' ? t('storage.sandboxedHint') : t('storage.unsupported'),
)

function close(): void {
  emit('update:modelValue', false)
}

async function refresh(): Promise<void> {
  info.value = await getStorageInfo()
  if (info.value.rootPath) rootInput.value = info.value.rootPath
}

/** 处理迁移结果提示 */
function report(result: { books: number; notes: number }): void {
  failed.value = false
  message.value = t('storage.migrated', { books: result.books, notes: result.notes })
  emit('toast', message.value, 'success')
  emit('changed')
}

async function run(task: () => Promise<void>): Promise<void> {
  busy.value = true
  message.value = ''
  failed.value = false
  try {
    await task()
  } catch (error) {
    failed.value = true
    message.value = error instanceof Error ? error.message : t('storage.failed')
    emit('toast', message.value, 'error')
  } finally {
    busy.value = false
    await refresh()
  }
}

/** 选择非目录模式 */
function select(option: ModeOption): void {
  if (option.disabled || busy.value) return
  if (option.value === info.value.mode && !info.value.needsPermission) return
  void run(async () => {
    const result = await switchStorage(option.value, null, true)
    report(result)
  })
}

/** 选择本地文件夹 */
function chooseFolder(): void {
  void run(async () => {
    let handle: Awaited<ReturnType<typeof pickDirectory>> = null
    try {
      handle = await pickDirectory()
    } catch (error) {
      // 沙箱页面调用选择器会被 Chrome 直接拒绝，转成可读提示
      if (error instanceof DOMException && error.name === 'SecurityError') {
        throw new Error(t('storage.sandboxedHint'))
      }
      throw error
    }
    if (!handle) return
    const result = await switchStorage('directory', handle, true)
    report(result)
  })
}

/** 保存自定义书库路径 */
function saveRoot(): void {
  const path = rootInput.value.trim()
  if (!path) return
  void run(async () => {
    const detail = await changeSidecarRoot(path)
    failed.value = false
    message.value = t('storage.pathSaved', { path: detail.root })
    emit('toast', message.value, 'success')
    emit('changed')
  })
}

/** 恢复默认书库路径 */
function resetRoot(): void {
  void run(async () => {
    const detail = await resetSidecarRoot()
    failed.value = false
    message.value = t('storage.pathSaved', { path: detail.root })
    emit('toast', message.value, 'success')
    emit('changed')
  })
}

/** 目录选择器开关 */
const pickerOpen = ref(false)

/** 打开目录选择器（只有原生后端可用时才有意义） */
function openPicker(): void {
  if (!info.value.hasSidecar) return
  pickerOpen.value = true
}

/** 选中目录后直接切换书库（选择器里的「选择此文件夹」本身就是一次确认） */
function onPicked(path: string): void {
  rootInput.value = path
  message.value = ''
  failed.value = false
  if (path === info.value.rootPath) return
  saveRoot()
}

/** 重新授权已选目录 */
function reconnect(): void {
  void run(async () => {
    const ok = await reconnectDirectory()
    if (!ok) throw new Error(t('storage.needPermission'))
    message.value = t('storage.reconnected')
    emit('toast', message.value, 'success')
    emit('changed')
  })
}

onMounted(refresh)
watch(
  () => props.modelValue,
  (open) => {
    if (open) void refresh()
  },
)
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
  width: min(560px, 94vw);
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
  padding: 16px 20px 20px;
}

.current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  background: var(--c-subtle);
  border: 1px solid var(--c-border);
}

.current-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.current .label {
  font-size: 11px;
  color: var(--c-text-3);
}

.current strong {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  flex: none;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}

.badge.ok {
  color: var(--c-success);
  background: color-mix(in srgb, var(--c-success) 12%, transparent);
}

.badge.warn {
  color: var(--c-danger);
  background: color-mix(in srgb, var(--c-danger) 12%, transparent);
}

.notice {
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius-m);
  font-size: 12px;
  color: var(--c-text-2);
  background: color-mix(in srgb, var(--c-danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--c-danger) 22%, transparent);
}

.current .sub {
  font-size: 11px;
  color: var(--c-text-3);
}

.path-box {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  border: 1px solid var(--c-border);
  background: var(--c-subtle);
}

.path-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-2);
}

.path-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

/* 路径通常很长，单独占一行，避免被按钮挤到只剩几个字符 */
.path-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.path-actions .spacer {
  flex: 1;
}

.path-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  font-size: 12.5px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--c-text);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
}

.path-input:focus {
  outline: none;
  border-color: var(--c-primary);
}

.path-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--c-text-3);
}

.path-default {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link {
  flex: none;
  padding: 0;
  font-size: 11.5px;
  color: var(--c-primary);
  background: none;
  border: none;
  cursor: pointer;
}

.path-hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--c-text-3);
}

.modes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}

.mode {
  text-align: left;
  padding: 12px 14px;
  border-radius: var(--radius-m);
  border: 1px solid var(--c-border);
  background: var(--c-panel);
  transition: border-color 0.16s, background 0.16s;
}

.mode:hover:not(.disabled) {
  background: var(--c-hover);
}

.mode.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
}

.mode.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.mode-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--c-text);
}

.mode-title {
  font-size: 13px;
  font-weight: 600;
}

.tag {
  margin-left: auto;
  font-size: 11px;
  color: var(--c-text-3);
}

.mode-desc {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--c-text-3);
}

.mode-path {
  display: inline-block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--c-primary);
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.hint {
  font-size: 12px;
  color: var(--c-text-3);
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

.note {
  margin: 12px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--c-text-3);
}
</style>
