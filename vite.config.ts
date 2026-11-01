import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

/**
 * 构建配置说明：
 * - base 使用相对路径 './'
 * - 产物输出到 ui/，与 manifest.json 中 entrypoints.ui.root = "ui" 保持一致
 * - 必须打成**单文件** bundle：DBX 宿主把插件页面注入沙箱 iframe
 *   （sandbox="allow-scripts"，CSP `default-src 'none'; script-src 'unsafe-inline' blob:`），
 *   宿主只会把 <script src> 与样式表**内联**进文档，无法内联或加载额外的 chunk / modulepreload，
 *   一旦拆包就会白屏。因此关闭代码分割、预加载与 CSS 拆分。
 * - PDF worker 用 ?raw 内联为 blob URL（见 src/core/parsers/pdf.ts），同样不产出独立文件
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'ui',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      output: {
        // 单一入口，不拆分第三方库
        inlineDynamicImports: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
})
