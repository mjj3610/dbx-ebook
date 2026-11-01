<!-- 通用二次确认对话框：高危操作（删除 / 清空 / 覆盖）必须经过此组件 -->
<template>
  <teleport to="body">
    <transition name="fade">
      <div v-if="modelValue" class="mask" @click.self="onCancel">
        <div class="dialog" role="alertdialog" aria-modal="true">
          <h3 class="title">{{ title }}</h3>
          <p class="desc">{{ description }}</p>
          <div class="actions">
            <button class="btn btn-ghost" @click="onCancel">{{ cancelText || t('common.cancel') }}</button>
            <button class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" :disabled="loading" @click="onConfirm">
              {{ loading ? t('common.loading') : confirmText || t('common.confirm') }}
            </button>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { t } from '../../i18n'

withDefaults(
  defineProps<{
    modelValue: boolean
    title: string
    description: string
    confirmText?: string
    cancelText?: string
    /** 高危操作使用红色主按钮 */
    danger?: boolean
    loading?: boolean
  }>(),
  { danger: true, loading: false },
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'confirm'): void
}>()

const onCancel = () => emit('update:modelValue', false)
const onConfirm = () => emit('confirm')
</script>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(18, 22, 30, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2500;
  backdrop-filter: blur(2px);
}

.dialog {
  width: min(420px, 88vw);
  background: var(--c-panel);
  border-radius: var(--radius-l);
  padding: 22px 22px 18px;
  box-shadow: var(--shadow-l);
}

.title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}

.desc {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--c-text-2);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
