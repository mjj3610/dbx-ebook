<!-- 设置面板：排版、听书、翻译三类配置，改动即时生效并持久化 -->
<template>
  <transition name="slide">
    <aside v-if="open" class="panel">
      <header class="panel-head">
        <h3>{{ t('settings.title') }}</h3>
        <button class="icon-btn" @click="emit('close')"><AppIcon name="close" /></button>
      </header>

      <div class="panel-body">
        <!-- 阅读模式 -->
        <section class="block">
          <h4>{{ t('mode.label') }}</h4>
          <div class="segmented">
            <button
              v-for="item in modes"
              :key="item.value"
              :class="{ active: reader.mode === item.value }"
              @click="reader.mode = item.value"
            >
              {{ t(item.label) }}
            </button>
          </div>
        </section>

        <!-- 排版 -->
        <section class="block">
          <h4>{{ t('settings.display') }}</h4>

          <div class="row">
            <span class="label">{{ t('settings.fontSize') }}</span>
            <div class="stepper">
              <button :disabled="reader.fontSize <= FONT_SIZE_MIN" @click="stepFont(-FONT_SIZE_STEP)">−</button>
              <span>{{ reader.fontSize }}</span>
              <button :disabled="reader.fontSize >= FONT_SIZE_MAX" @click="stepFont(FONT_SIZE_STEP)">＋</button>
            </div>
          </div>

          <div class="row">
            <span class="label">{{ t('settings.lineHeight') }}</span>
            <div class="stepper">
              <button :disabled="reader.lineHeight <= 1.2" @click="reader.lineHeight = round1(reader.lineHeight - 0.1)">−</button>
              <span>{{ reader.lineHeight.toFixed(1) }}</span>
              <button :disabled="reader.lineHeight >= 2.6" @click="reader.lineHeight = round1(reader.lineHeight + 0.1)">＋</button>
            </div>
          </div>

          <div class="row">
            <span class="label">{{ t('settings.margin') }}</span>
            <div class="stepper">
              <button :disabled="reader.padding <= PADDING_MIN" @click="stepPadding(-PADDING_STEP)">−</button>
              <span>{{ reader.padding }}</span>
              <button :disabled="reader.padding >= PADDING_MAX" @click="stepPadding(PADDING_STEP)">＋</button>
            </div>
          </div>

          <div class="row">
            <span class="label">{{ t('settings.fontFamily') }}</span>
            <div class="chips">
              <button
                v-for="(value, key) in FONT_FAMILIES"
                :key="key"
                class="chip"
                :class="{ active: reader.fontFamily === key }"
                @click="reader.fontFamily = key"
              >
                {{ value.label }}
              </button>
            </div>
          </div>

          <div class="row">
            <span class="label">{{ t('settings.theme') }}</span>
            <div class="swatches">
              <button
                v-for="(value, key) in THEMES"
                :key="key"
                class="swatch"
                :class="{ active: reader.theme === key }"
                :style="{ background: value.paper, borderColor: reader.theme === key ? 'var(--c-primary)' : value.border }"
                :title="value.label"
                @click="reader.theme = key"
              />
            </div>
          </div>

          <div class="row">
            <span class="label">{{ t('settings.language') }}</span>
            <select v-model="reader.locale" class="field">
              <option v-for="item in LOCALES" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </div>
        </section>

        <!-- 听书 -->
        <section class="block">
          <h4>{{ t('reader.listen') }}</h4>
          <div class="row">
            <span class="label">{{ t('settings.voice') }}</span>
            <select v-model="settings.tts.voiceURI" class="field">
              <option value="">{{ t('settings.voice') }}（自动）</option>
              <option v-for="voice in voices" :key="voice.uri" :value="voice.uri">{{ voice.name }}</option>
            </select>
          </div>
          <div class="row">
            <span class="label">{{ t('settings.rate') }}</span>
            <div class="slider">
              <input v-model.number="settings.tts.rate" type="range" min="0.5" max="2" step="0.1" />
              <span>{{ settings.tts.rate.toFixed(1) }}×</span>
            </div>
          </div>
          <div class="row">
            <span class="label">{{ t('settings.pitch') }}</span>
            <div class="slider">
              <input v-model.number="settings.tts.pitch" type="range" min="0.5" max="2" step="0.1" />
              <span>{{ settings.tts.pitch.toFixed(1) }}</span>
            </div>
          </div>
        </section>

        <!-- 翻译 -->
        <section class="block">
          <h4>{{ t('translate.title') }}</h4>
          <div class="row">
            <span class="label">{{ t('translate.provider') }}</span>
            <select v-model="settings.translate.provider" class="field">
              <option value="openai">OpenAI 兼容</option>
              <option value="libre">LibreTranslate</option>
            </select>
          </div>

          <template v-if="settings.translate.provider === 'openai'">
            <div class="row column">
              <span class="label">{{ t('translate.baseUrl') }}</span>
              <input v-model.trim="settings.translate.baseUrl" class="field" placeholder="https://api.openai.com/v1" />
            </div>
            <div class="row column">
              <span class="label">{{ t('translate.apiKey') }}</span>
              <input v-model.trim="settings.translate.apiKey" class="field" type="password" autocomplete="off" />
            </div>
            <div class="row column">
              <span class="label">{{ t('translate.model') }}</span>
              <input v-model.trim="settings.translate.model" class="field" placeholder="gpt-4o-mini" />
            </div>
          </template>
          <template v-else>
            <div class="row column">
              <span class="label">{{ t('translate.libreUrl') }}</span>
              <input v-model.trim="settings.translate.libreUrl" class="field" placeholder="https://libretranslate.com" />
            </div>
          </template>

          <div class="row">
            <span class="label">{{ t('translate.targetLang') }}</span>
            <select v-model="settings.translate.targetLang" class="field">
              <option value="zh">简体中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="th">ไทย</option>
            </select>
          </div>
          <p class="tip">{{ t('translate.needConfig') }}</p>
        </section>

        <section class="block">
          <button class="btn btn-ghost full" @click="emit('backup')">
            <AppIcon name="cloud" :size="16" />
            {{ t('backup.title') }}
          </button>
        </section>
      </div>
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import { FONT_FAMILIES, FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SIZE_STEP, PADDING_MAX, PADDING_MIN, PADDING_STEP, THEMES } from '../../core/constants'
import { persistReader, persistTranslate, persistTts, settings } from '../../core/settings'
import { TtsPlayer, type VoiceOption } from '../../core/tts'
import type { ReadingMode, ReaderSettings } from '../../core/types'
import { LOCALES, t } from '../../i18n'

defineProps<{ open: boolean }>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'backup'): void
}>()

const reader = settings.reader
const voices = ref<VoiceOption[]>([])

/** 阅读模式选项 */
const modes: Array<{ value: ReadingMode; label: string }> = [
  { value: 'paged', label: 'mode.paged' },
  { value: 'double', label: 'mode.double' },
  { value: 'scroll', label: 'mode.scroll' },
]

/** 保留一位小数 */
const round1 = (value: number): number => Math.round(value * 10) / 10

/** 字号步进（受范围约束） */
const stepFont = (delta: number) => {
  reader.fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, reader.fontSize + delta))
}

/** 页边距步进 */
const stepPadding = (delta: number) => {
  reader.padding = Math.min(PADDING_MAX, Math.max(PADDING_MIN, reader.padding + delta))
}

onMounted(async () => {
  voices.value = await TtsPlayer.listVoices(reader.locale === 'en' ? 'en' : 'zh')
})

// 变更即持久化
watch(() => JSON.stringify(settings.reader), persistReader)
watch(() => JSON.stringify(settings.tts), persistTts)
watch(() => JSON.stringify(settings.translate), persistTranslate)

// 字体设置类型约束
watch(
  () => settings.reader.fontFamily as ReaderSettings['fontFamily'],
  () => undefined,
)
</script>

<style scoped>
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(360px, 88vw);
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
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 18px 30px;
}

.block {
  padding: 14px 0;
  border-bottom: 1px solid var(--c-border);
}

.block:last-child {
  border-bottom: none;
}

.block h4 {
  margin: 0 0 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-3);
  letter-spacing: 0.4px;
}

.segmented {
  display: flex;
  background: var(--c-subtle);
  border-radius: var(--radius-m);
  padding: 3px;
  gap: 3px;
}

.segmented button {
  flex: 1;
  height: 30px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--c-text-2);
  transition: background 0.16s, color 0.16s, box-shadow 0.16s;
}

.segmented button.active {
  background: var(--c-panel);
  color: var(--c-primary);
  font-weight: 600;
  box-shadow: var(--shadow-s);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.row.column {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

.label {
  font-size: 12.5px;
  color: var(--c-text-2);
  flex: none;
}

.field {
  min-width: 120px;
  max-width: 100%;
}

.stepper {
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  overflow: hidden;
}

.stepper button {
  width: 28px;
  height: 28px;
  color: var(--c-text-2);
  font-size: 14px;
}

.stepper button:hover:not(:disabled) {
  background: var(--c-hover);
}

.stepper button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.stepper span {
  min-width: 38px;
  text-align: center;
  font-size: 12px;
  color: var(--c-text);
}

.chips {
  display: flex;
  gap: 6px;
}

.chip {
  padding: 5px 10px;
  border-radius: 20px;
  border: 1px solid var(--c-border);
  font-size: 12px;
  color: var(--c-text-2);
}

.chip.active {
  border-color: var(--c-primary);
  color: var(--c-primary);
  background: var(--c-primary-soft);
}

.swatches {
  display: flex;
  gap: 8px;
}

.swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid var(--c-border);
  transition: transform 0.14s;
}

.swatch.active {
  transform: scale(1.12);
}

.slider {
  display: flex;
  align-items: center;
  gap: 8px;
}

.slider input {
  width: 118px;
  padding: 0;
  border: none;
  background: transparent;
}

.slider span {
  font-size: 11px;
  color: var(--c-text-3);
  min-width: 32px;
  text-align: right;
}

.tip {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--c-text-3);
}

.full {
  width: 100%;
}
</style>
