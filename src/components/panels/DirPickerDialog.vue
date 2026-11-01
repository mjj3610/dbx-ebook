<!-- 文件夹选择器：沙箱里用不了系统选择器，改由原生后端列目录、插件自绘 -->
<template>
  <teleport to="body">
    <transition name="fade">
      <div v-if="modelValue" class="mask" @click.self="close">
        <div class="picker">
          <header class="head">
            <h3>{{ t('storage.pickerTitle') }}</h3>
            <button class="icon-btn" @click="close"><AppIcon name="close" /></button>
          </header>

          <div class="body">
            <!-- 左侧：磁盘与常用位置 -->
            <aside class="side">
              <div v-if="listing.roots.length" class="group">
                <span class="group-title">{{ t('storage.pickerDrive') }}</span>
                <button
                  v-for="item in listing.roots"
                  :key="item.path"
                  class="side-item"
                  :class="{ active: listing.path === item.path }"
                  @click="go(item.path)"
                >
                  <AppIcon name="folder" :size="14" />
                  <span class="ellipsis">{{ item.name }}</span>
                </button>
              </div>
              <div v-if="listing.shortcuts.length" class="group">
                <button
                  v-for="item in listing.shortcuts"
                  :key="item.path"
                  class="side-item"
                  :class="{ active: listing.path === item.path }"
                  :title="item.path"
                  @click="go(item.path)"
                >
                  <AppIcon name="folder" :size="14" />
                  <span class="ellipsis">{{ shortcutLabel(item.key) }}</span>
                </button>
              </div>
            </aside>

            <!-- 右侧：当前目录内容 -->
            <section class="main">
              <div class="bar">
                <button class="icon-btn up" :disabled="!listing.parent || loading" :title="t('storage.pickerUp')" @click="go(listing.parent)">
                  <AppIcon name="arrowUp" :size="16" />
                </button>
                <!-- 地址栏：点击即变成可输入，粘贴 D:\xxx 直接跳转 -->
                <input
                  v-if="editing"
                  ref="pathInput"
                  v-model="pathDraft"
                  class="path-input"
                  spellcheck="false"
                  :placeholder="t('storage.pickerPathPlaceholder')"
                  @keydown.enter="jump"
                  @keydown.esc="cancelEdit"
                  @blur="cancelEdit"
                />
                <button v-else class="crumb" :title="t('storage.pickerPathEdit')" @click="startEdit">
                  <span class="ellipsis">{{ listing.path || t('storage.pickerDrive') }}</span>
                </button>
                <button
                  class="icon-btn"
                  :disabled="!listing.path || loading"
                  :title="t('storage.pickerReveal')"
                  :aria-label="t('storage.pickerReveal')"
                  @click="revealCurrent"
                >
                  <AppIcon name="external" :size="15" />
                </button>
                <button class="btn btn-ghost small" :disabled="!listing.path || loading" @click="toggleCreate">
                  <AppIcon name="plus" :size="14" />
                  {{ t('storage.pickerNew') }}
                </button>
              </div>

              <div v-if="creating" class="create-row">
                <input
                  v-model="newName"
                  class="create-input"
                  spellcheck="false"
                  :placeholder="t('storage.pickerNewPlaceholder')"
                  @keydown.enter="createDir"
                />
                <button class="btn btn-primary small" :disabled="!newName.trim() || loading" @click="createDir">
                  {{ t('storage.pickerCreate') }}
                </button>
              </div>

              <div class="list">
                <p v-if="loading" class="empty">{{ t('storage.pickerLoading') }}</p>
                <p v-else-if="error" class="empty error">{{ error }}</p>
                <p v-else-if="!listing.path" class="empty">{{ t('storage.pickerPickStart') }}</p>
                <p v-else-if="!listing.entries.length" class="empty">{{ t('storage.pickerEmpty') }}</p>
                <template v-else>
                  <button
                    v-for="entry in listing.entries"
                    :key="entry.path"
                    class="entry"
                    :title="entry.path"
                    @click="go(entry.path)"
                  >
                    <AppIcon name="folder" :size="15" />
                    <span class="ellipsis">{{ entry.name }}</span>
                  </button>
                </template>
              </div>
            </section>
          </div>

          <footer class="foot">
            <span class="target ellipsis" :title="listing.path">{{ listing.path || '—' }}</span>
            <span v-if="listing.path && listing.writable === false" class="warn">{{ t('storage.pickerReadonly') }}</span>
            <span class="spacer" />
            <button class="btn btn-ghost" @click="close">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="!listing.path || loading || listing.writable === false" @click="confirm">
              {{ t('storage.pickerChoose') }}
            </button>
          </footer>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import { listDirs, makeDir, revealDir, type DirListing } from '../../core/sidecar'
import { t } from '../../i18n'

const props = defineProps<{
  modelValue: boolean
  /** 打开时定位到的目录 */
  startPath?: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'select', path: string): void
  (event: 'toast', message: string, type?: 'info' | 'success' | 'error'): void
}>()

const listing = ref<DirListing>({ path: '', parent: '', entries: [], roots: [], shortcuts: [] })
const loading = ref(false)
const error = ref('')
const creating = ref(false)
const newName = ref('')
const editing = ref(false)
const pathDraft = ref('')
const pathInput = ref<HTMLInputElement | null>(null)

/** 快捷位置的显示名 */
function shortcutLabel(key: string): string {
  const labels: Record<string, string> = {
    library: t('storage.shortcutLibrary'),
    data: t('storage.shortcutData'),
    home: t('storage.shortcutHome'),
    documents: t('storage.shortcutDocuments'),
    desktop: t('storage.shortcutDesktop'),
    downloads: t('storage.shortcutDownloads'),
  }
  return labels[key] ?? key
}

/** 进入某个目录；传空串表示回到磁盘/快捷位置首页 */
async function go(path: string): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    listing.value = await listDirs(path)
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('storage.pickerFailed')
  } finally {
    loading.value = false
  }
}

/** 用系统资源管理器打开当前目录，方便用户在里面浏览、复制地址栏路径 */
async function revealCurrent(): Promise<void> {
  if (!listing.value.path) return
  try {
    await revealDir(listing.value.path)
  } catch (err) {
    emit('toast', err instanceof Error ? err.message : t('storage.pickerFailed'), 'error')
  }
}

function toggleCreate(): void {
  creating.value = !creating.value
  newName.value = ''
}

/** 地址栏进入编辑态：预填当前路径，聚焦并全选，方便直接粘贴覆盖 */
function startEdit(): void {
  editing.value = true
  pathDraft.value = listing.value.path
  void nextTick(() => {
    pathInput.value?.focus()
    pathInput.value?.select()
  })
}

function cancelEdit(): void {
  editing.value = false
  pathDraft.value = ''
}

/** 地址栏回车：直接跳到输入的绝对路径 */
async function jump(): Promise<void> {
  const target = pathDraft.value.trim()
  editing.value = false
  if (!target || target === listing.value.path) return
  await go(target)
  // go 失败时不会改动 listing，界面上仍停在原目录，这里只补一条提示
  if (error.value) {
    const message = error.value
    error.value = ''
    emit('toast', message, 'error')
  }
}

/** 在当前目录下新建文件夹，并直接进入 */
async function createDir(): Promise<void> {
  const name = newName.value.trim()
  if (!name || !listing.value.path) return
  loading.value = true
  error.value = ''
  try {
    const result = await makeDir(listing.value.path, name)
    creating.value = false
    newName.value = ''
    emit('toast', t('storage.pickerCreated', { path: result.path }), 'success')
    await go(result.path)
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('storage.pickerFailed')
  } finally {
    loading.value = false
  }
}

function confirm(): void {
  if (!listing.value.path) return
  emit('select', listing.value.path)
  emit('update:modelValue', false)
}

function close(): void {
  emit('update:modelValue', false)
}

async function init(): Promise<void> {
  creating.value = false
  newName.value = ''
  const start = (props.startPath ?? '').trim()
  // 先定位到当前书库，用户熟悉的位置；失败（目录被删/换机器）再从磁盘列表开始
  if (start) await go(start)
  if (!start || error.value) await go('')
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void init()
  },
)
onMounted(() => {
  if (props.modelValue) void init()
})
</script>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(18, 22, 30, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 必须盖在存储对话框（2300）之上 */
  z-index: 2400;
  backdrop-filter: blur(2px);
}

.picker {
  width: min(720px, 96vw);
  height: min(540px, 90vh);
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
  display: flex;
  min-height: 0;
}

.side {
  width: 160px;
  flex: none;
  overflow-y: auto;
  padding: 10px 8px;
  border-right: 1px solid var(--c-border);
  background: var(--c-subtle);
}

.group + .group {
  margin-top: 12px;
}

.group-title {
  display: block;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--c-text-3);
}

.side-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  font-size: 12.5px;
  color: var(--c-text-2);
  background: none;
  border: none;
  border-radius: var(--radius-s);
  cursor: pointer;
  text-align: left;
}

.side-item:hover {
  background: var(--c-hover);
}

.side-item.active {
  color: var(--c-primary);
  background: var(--c-primary-soft);
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--c-border);
}

.up {
  flex: none;
}

.crumb {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--c-text-2);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  cursor: text;
  text-align: left;
}

.crumb:hover {
  border-color: var(--c-primary);
}

.path-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--c-text);
  background: var(--c-panel);
  border: 1px solid var(--c-primary);
  border-radius: var(--radius-s);
}

.path-input:focus {
  outline: none;
}

.create-row {
  flex: none;
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-subtle);
}

.create-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  font-size: 12.5px;
  color: var(--c-text);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
}

.create-input:focus {
  outline: none;
  border-color: var(--c-primary);
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.entry {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  font-size: 13px;
  color: var(--c-text);
  background: none;
  border: none;
  border-radius: var(--radius-s);
  cursor: pointer;
  text-align: left;
}

.entry:hover {
  background: var(--c-hover);
}

.ellipsis {
  /* 必须能占满剩余宽度：只写 min-width:0 时，窄面板里会被挤到只剩首字 */
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  margin: 24px 12px;
  font-size: 12.5px;
  color: var(--c-text-3);
  text-align: center;
}

.empty.error {
  color: var(--c-danger);
}

.foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--c-border);
}

.target {
  flex: 0 1 auto;
  max-width: 46%;
  font-size: 11.5px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--c-text-3);
}

.warn {
  flex: none;
  font-size: 11.5px;
  color: var(--c-danger);
}

.spacer {
  flex: 1;
}

.btn.small {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
}

/*
 * 宿主侧边栏宽度有限（常见 380–520px），左右分栏会把目录名挤成只剩首字。
 * 窄面板下改为上下布局：磁盘/快捷位置变成顶部的一排标签，列表占满整行。
 */
@media (max-width: 620px) {
  .body {
    flex-direction: column;
  }

  .side {
    width: auto;
    max-height: 124px;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 4px;
    border-right: none;
    border-bottom: 1px solid var(--c-border);
  }

  .group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    width: 100%;
  }

  .group + .group {
    margin-top: 2px;
  }

  .group-title {
    width: 100%;
    padding: 2px 2px 0;
  }

  .side-item {
    width: auto;
    max-width: 46%;
    padding: 4px 8px;
  }

  .entry {
    padding: 8px 6px;
  }

  .foot .target {
    display: none;
  }
}
</style>
