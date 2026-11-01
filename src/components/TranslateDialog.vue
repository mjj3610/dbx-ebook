<!-- 翻译浮层：展示原文与译文，支持复制 -->
<template>
  <teleport to="body">
    <transition name="fade">
      <div v-if="modelValue" class="mask" @click.self="close">
        <div class="dialog">
          <header class="head">
            <h3>{{ t('translate.title') }}</h3>
            <button class="icon-btn" @click="close"><AppIcon name="close" /></button>
          </header>

          <div class="body">
            <div class="block">
              <span class="label">{{ t('translate.source') }}</span>
              <p class="source">{{ source }}</p>
            </div>

            <div class="block">
              <span class="label">{{ t('translate.result') }}</span>
              <p v-if="loading" class="loading">{{ t('translate.translating') }}</p>
              <p v-else-if="error" class="error">{{ error }}</p>
              <p v-else class="result">{{ result }}</p>
            </div>
          </div>

          <footer class="foot">
            <button v-if="error && !configured" class="btn btn-ghost" @click="emit('config')">
              {{ t('translate.config') }}
            </button>
            <button class="btn btn-ghost" @click="copy">{{ t('common.copy') }}</button>
            <button class="btn btn-primary" :disabled="loading" @click="run">{{ t('common.retry') }}</button>
          </footer>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import AppIcon from './ui/AppIcon.vue'
import { copyText } from '../core/host'
import { isTranslateConfigured, translateText } from '../core/translate'
import { t } from '../i18n'

const props = defineProps<{
  modelValue: boolean
  source: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'config'): void
  (event: 'copied'): void
}>()

const loading = ref(false)
const error = ref('')
const result = ref('')
const configured = ref(true)

/** 关闭 */
const close = () => emit('update:modelValue', false)

/** 执行翻译 */
async function run(): Promise<void> {
  if (!props.source.trim()) return
  loading.value = true
  error.value = ''
  configured.value = isTranslateConfigured()
  try {
    result.value = await translateText(props.source)
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('translate.failed')
  } finally {
    loading.value = false
  }
}

/** 复制译文 */
async function copy(): Promise<void> {
  const ok = await copyText(result.value || props.source)
  if (ok) emit('copied')
}

// 打开时自动翻译
watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return
    result.value = ''
    error.value = ''
    void run()
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
  z-index: 2200;
  backdrop-filter: blur(2px);
}

.dialog {
  width: min(560px, 92vw);
  max-height: 80vh;
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
  padding: 16px 20px;
}

.block {
  margin-bottom: 16px;
}

.label {
  font-size: 11px;
  font-weight: 600;
  color: var(--c-text-3);
  letter-spacing: 0.4px;
}

.source,
.result,
.loading,
.error {
  margin: 6px 0 0;
  font-size: 13.5px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.source {
  color: var(--c-text-2);
  background: var(--c-subtle);
  border-radius: var(--radius-m);
  padding: 10px 12px;
  max-height: 180px;
  overflow-y: auto;
}

.result {
  color: var(--c-text);
}

.loading {
  color: var(--c-text-3);
}

.error {
  color: var(--c-danger);
}

.foot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid var(--c-border);
}
</style>
