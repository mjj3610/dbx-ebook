/**
 * WebDAV 网盘备份：兼容坚果云、Nextcloud、群晖等标准 WebDAV 服务
 * 仅使用基础方法：MKCOL（建目录）、PUT（上传）、GET（下载）、PROPFIND（连通性检测）
 */
import { netFetch } from './net'
import { settings } from './settings'
import { formatBytes } from './utils'

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 30_000

/** WebDAV 错误 */
export class WebdavError extends Error {}

/** Base64 编码（正确处理 UTF-8 用户名/密码） */
function encodeBasicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return `btoa(binary)`
}

/** 构造请求头 */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  if (settings.webdav.username) {
    headers.Authorization = `Basic ${encodeBasicAuth(settings.webdav.username, settings.webdav.password)}`
  }
  return headers
}

/** 规范化远端地址 */
function baseUrl(): string {
  return settings.webdav.url.trim().replace(/\/$/, '')
}

/** 完整文件地址 */
function fileUrl(): string {
  const base = baseUrl()
  const name = settings.webdav.filename.trim() || 'dbx-ebook-backup.dbxebook'
  return `${base}/${encodeURIComponent(name)}`
}

/** 带超时请求（宿主沙箱里 fetch 被 CSP 挡住，统一走 netFetch 由后端代发） */
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await netFetch(url, {
      method: init.method,
      headers: { ...authHeaders(), ...((init.headers as Record<string, string>) ?? {}) },
      body: init.body as BodyInit | undefined,
      timeoutMs: REQUEST_TIMEOUT,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/timeout|超时|deadline/i.test(message)) {
      throw new WebdavError('连接超时，请检查网盘地址与网络')
    }
    throw new WebdavError(`无法连接网盘：${message || '请确认地址正确，且服务端已允许访问'}`)
  }
}

/** 是否已配置 */
export function isWebdavConfigured(): boolean {
  return Boolean(settings.webdav.url.trim())
}

/**
 * 测试连接
 * @returns 可读的成功信息
 */
export async function testWebdav(): Promise<string> {
  if (!isWebdavConfigured()) throw new WebdavError('请先填写 WebDAV 地址')
  const response = await request(baseUrl(), {
    method: 'PROPFIND',
    headers: { Depth: '0', 'Content-Type': 'application/xml' },
  })
  if (response.status === 401 || response.status === 403) {
    throw new WebdavError('认证失败：请检查用户名与密码（坚果云需使用应用密码）')
  }
  if (response.status === 404) {
    throw new WebdavError('目录不存在，请检查路径是否正确')
  }
  if (!response.ok && response.status !== 207) {
    throw new WebdavError(`服务端返回 ${response.status}，请确认该地址支持 WebDAV`)
  }
  return '连接成功，可正常读写'
}

/** 确保目标目录存在（不存在则创建） */
async function ensureCollection(): Promise<void> {
  const response = await request(baseUrl(), { method: 'PROPFIND', headers: { Depth: '0' } })
  if (response.status === 404) {
    const created = await request(baseUrl(), { method: 'MKCOL' })
    if (!created.ok && created.status !== 405) {
      throw new WebdavError(`创建备份目录失败（${created.status}）`)
    }
    return
  }
  if (response.status === 207 || response.ok) return
  if (response.status === 401 || response.status === 403) {
    throw new WebdavError('认证失败，请检查账号密码')
  }
}

/**
 * 上传备份
 * @returns 上传结果描述
 */
export async function uploadBackup(blob: Blob): Promise<string> {
  if (!isWebdavConfigured()) throw new WebdavError('请先填写 WebDAV 地址')
  await ensureCollection()
  const response = await request(fileUrl(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  })
  if (!response.ok) {
    throw new WebdavError(`上传失败（${response.status}），请确认账号具备写入权限`)
  }
  return `已上传 ${formatBytes(blob.size)} 至 ${settings.webdav.filename}`
}

/**
 * 下载备份
 * @returns 备份文件内容
 */
export async function downloadBackup(): Promise<File> {
  if (!isWebdavConfigured()) throw new WebdavError('请先填写 WebDAV 地址')
  const response = await request(fileUrl(), { method: 'GET' })
  if (response.status === 404) throw new WebdavError('云端未找到备份文件，请先上传一次')
  if (response.status === 401 || response.status === 403) throw new WebdavError('认证失败，请检查账号密码')
  if (!response.ok) throw new WebdavError(`下载失败（${response.status}）`)
  const blob = await response.blob()
  return new File([blob], settings.webdav.filename, { type: blob.type })
}

/** 获取云端备份元信息（大小 / 修改时间） */
export async function statBackup(): Promise<{ size: number; modified: string } | null> {
  if (!isWebdavConfigured()) return null
  try {
    const response = await request(fileUrl(), { method: 'HEAD' })
    if (!response.ok) return null
    return {
      size: Number(response.headers.get('Content-Length') ?? 0),
      modified: response.headers.get('Last-Modified') ?? '',
    }
  } catch {
    return null
  }
}
