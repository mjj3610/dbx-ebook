/**
 * 应用入口
 * 顺序：读取本地设置 → 初始化存储（可能回落到内存/目录）→ 等待 DBX 宿主就绪（应用宿主语言/主题）→ 挂载
 */
import { createApp } from 'vue'
import App from './App.vue'
import { initStorage } from './core/db'
import { initHostBridge } from './core/host'
import { applyHostDefaults, loadSettings } from './core/settings'
import './style.css'

async function bootstrap(): Promise<void> {
  // 设置需在挂载前载入，保证首屏主题与语言正确
  loadSettings()
  // 存储模式决定数据来源，必须在首屏书架查询前就绪
  await initStorage()
  const host = await initHostBridge()
  if (host) applyHostDefaults(host.appearance, host.locale as 'zh-CN' | 'en')
  createApp(App).mount('#app')
}

void bootstrap()
