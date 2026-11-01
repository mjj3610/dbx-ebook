<!-- 统一图标组件：内置线性图标路径，避免额外图标库依赖 -->
<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, index) in paths" :key="index" :d="d" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 图标名 */
    name: string
    /** 尺寸 px */
    size?: number | string
    /** 线宽 */
    strokeWidth?: number
  }>(),
  { size: 18, strokeWidth: 1.8 },
)

/** 图标路径表（24×24 视图） */
const ICONS: Record<string, string[]> = {
  book: [
    'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z',
    'M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5',
  ],
  library: ['M4 4h4v16H4z', 'M10 4h4v16h-4z', 'm16 5 4 15-3.6 1L12.4 6z'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'm20 20-3.5-3.5'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  more: ['M12 6h.01', 'M12 12h.01', 'M12 18h.01'],
  toc: ['M4 6h11', 'M4 12h11', 'M4 18h7', 'M18 5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
  note: ['M4 5h16v11l-4 4H4z', 'M20 16h-4v4', 'M8 9h8', 'M8 13h5'],
  headphones: ['M4 15v-3a8 8 0 0 1 16 0v3', 'M4 15h2.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M20 15h-2.5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1H19a1 1 0 0 0 1-1z'],
  translate: ['M4 6h9', 'M8.5 6c0 4.5-2 7.5-4.5 9', 'M6 11c1.6 2.6 4 4.4 6 5', 'm12 20 4.5-11L21 20', 'M13.6 17h5.8'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-2.9-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.57-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09A1.7 1.7 0 0 0 21 10.66h.09a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1z',
  ],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  chevronLeft: ['m14 7-5 5 5 5'],
  chevronRight: ['m10 7 5 5-5 5'],
  arrowLeft: ['M19 12H5', 'm11 6-6 6 6 6'],
  cloud: ['M7 18a4 4 0 0 1 .6-7.95A5.5 5.5 0 0 1 18.4 11 3.5 3.5 0 0 1 17.5 18z'],
  upload: ['M12 16V4', 'm7 9 5-5 5 5', 'M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2'],
  download: ['M12 4v12', 'm7 11 5 5 5-5', 'M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2'],
  check: ['m5 13 4 4L19 7'],
  play: ['m8 5 11 7-11 7z'],
  pause: ['M9 5v14', 'M15 5v14'],
  stop: ['M6 6h12v12H6z'],
  palette: ['M12 21a9 9 0 1 1 0-18c5 0 9 3.6 9 8 0 2.2-1.8 4-4 4h-1.5a2 2 0 0 0-1.4 3.4A2 2 0 0 1 12 21z', 'M8.5 10h.01', 'M12 7.5h.01', 'M15.5 10h.01'],
  text: ['M4 6h16', 'M4 12h10', 'M4 18h13'],
  highlight: ['m9 14 8.5-8.5a2 2 0 0 1 3 3L12 17l-4 1z', 'M3 21h18'],
  zoomIn: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'm20 20-3.5-3.5', 'M11 8v6', 'M8 11h6'],
  zoomOut: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'm20 20-3.5-3.5', 'M8 11h6'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8h.01'],
  external: ['M14 4h6v6', 'M20 4 11 13', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
  folder: ['M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7.5A1.5 1.5 0 0 1 19.5 9.5v8A1.5 1.5 0 0 1 18 19H4.5A1.5 1.5 0 0 1 3 17.5z'],
  arrowUp: ['M12 19V5', 'm6 11 6-6 6 6'],
}

const paths = computed(() => ICONS[props.name] ?? ICONS.info)
</script>

<style scoped>
.icon {
  display: block;
  flex: none;
}
</style>
