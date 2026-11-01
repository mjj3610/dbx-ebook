<!-- 全局轻提示 -->
<template>
  <div class="toast-wrap">
    <transition-group name="toast">
      <div v-for="item in items" :key="item.id" class="toast" :class="`toast-${item.type}`">
        <span class="dot" />
        <span class="msg">{{ item.text }}</span>
      </div>
    </transition-group>
  </div>
</template>

<script setup lang="ts">
export interface ToastItem {
  id: number
  text: string
  type: 'info' | 'success' | 'error'
}

defineProps<{ items: ToastItem[] }>()
</script>

<style scoped>
.toast-wrap {
  position: fixed;
  left: 50%;
  bottom: 32px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 3000;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: var(--radius-m);
  background: rgba(24, 28, 36, 0.92);
  color: #fff;
  font-size: 13px;
  box-shadow: var(--shadow-m);
  backdrop-filter: blur(8px);
  max-width: min(560px, 76vw);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9aa4b2;
  flex: none;
}

.toast-success .dot {
  background: #3ddc84;
}

.toast-error .dot {
  background: #ff6b6b;
}

.msg {
  line-height: 1.5;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
