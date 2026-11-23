/**
 * ComfyUI HTTP 客户端。只依赖 Node 22 内置的 fetch / FormData / Blob。
 * 所有对 ComfyUI 的访问都从 Host 侧发出，浏览器侧只访问 DSH 同源的 /api/dsh-comfyui-desk/*。
 */

import os from 'node:os'
import { execFile } from 'node:child_process'

export class ComfyError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'ComfyError'
    this.status = options.status
    this.code = options.code
    this.detail = options.detail
  }
}

const objectInfoCache = new Map()
const CACHE_TTL_MS = 60_000

export function normalizeBase(value) {
  let base = String(value ?? '').trim()
  if (base === '') base = 'http://127.0.0.1:8188'
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`
  base = base.replace(/\/+$/, '')
  try {
    const url = new URL(base)
    if (url.username || url.password) throw new Error('地址不应包含用户名或密码')
    return url.origin
  } catch (error) {
    throw new ComfyError(`ComfyUI 地址不合法：${error.message}`, { code: 'bad-base' })
  }
}

function withTimeout(timeout, signal) {
  if (typeof AbortSignal.any === 'function' && signal) {
    return AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  }
  return signal ?? AbortSignal.timeout(timeout)
}

async function request(base, pathname, options = {}) {
  const { method = 'GET', body, timeout = 10_000, signal, raw = false } = options
  const url = `${normalizeBase(base)}${pathname}`
  let response
  try {
    response = await fetch(url, {
      method,
      signal: withTimeout(timeout, signal),
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ComfyError(`连接 ComfyUI 超时：${url}`, { code: 'timeout' })
    }
    throw new ComfyError(`无法连接 ComfyUI：${url}（${error.message}）`, { code: 'unreachable' })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ComfyError(`ComfyUI 返回 HTTP ${response.status}：${text.slice(0, 240)}`, {
      status: response.status,
      code: 'http',
      detail: text.slice(0, 2000),
    })
  }
  if (raw) return response
  const text = await response.text()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** GET /system_stats —— 系统、显存、设备信息。 */
export async function systemStats(base, options = {}) {
  return request(base, '/system_stats', options)
}

/** GET /queue —— 运行中 / 等待中的任务。 */
export async function queueState(base, options = {}) {
  return request(base, '/queue', options)
}

/** GET /object_info —— 节点定义与模型列表（带 60 秒缓存）。 */
export async function objectInfo(base, options = {}) {
  const key = normalizeBase(base)
  const now = Date.now()
  const cached = objectInfoCache.get(key)
  if (!options.force && cached && now - cached.at < CACHE_TTL_MS) return cached.data
  if (cached?.promise) return cached.promise
  const promise = request(base, '/object_info', { timeout: options.timeout ?? 20_000, signal: options.signal })
    .then((data) => {
      objectInfoCache.set(key, { at: Date.now(), data })
      return data
    })
    .catch((error) => {
      objectInfoCache.delete(key)
      throw error
    })
  objectInfoCache.set(key, { at: now, promise })
  return promise
}

/** GET /object_info/<class_type> —— 单个节点定义。 */
export async function nodeInfo(base, classType, options = {}) {
  if (typeof classType !== 'string' || classType === '' || /[^A-Za-z0-9_.-]/.test(classType)) {
    throw new ComfyError('节点类型不合法', { code: 'bad-node' })
  }
  return request(base, `/object_info/${encodeURIComponent(classType)}`, options)
}

/** GET /history?max_items=N —— 最近运行记录。 */
export async function history(base, limit = 20, options = {}) {
  const data = await request(base, `/history?max_items=${encodeURIComponent(limit)}`, options)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return []
  return Object.entries(data).map(([id, value]) => ({ id, ...(value ?? {}) }))
    .sort((a, b) => Number(b?.prompt?.[0] ?? 0) - Number(a?.prompt?.[0] ?? 0))
}

/** GET /history/<prompt_id> —— 单次运行状态。 */
export async function historyOne(base, promptId, options = {}) {
  if (typeof promptId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(promptId)) {
    throw new ComfyError('promptId 不合法', { code: 'bad-id' })
  }
  return request(base, `/history/${encodeURIComponent(promptId)}`, options)
}

/** POST /prompt —— 提交 API 格式工作流。 */
export async function submitPrompt(base, prompt, clientId, options = {}) {
  const body = { prompt }
  if (typeof clientId === 'string' && clientId !== '') body.client_id = clientId
  return request(base, '/prompt', { method: 'POST', body, ...options })
}

/** POST /interrupt —— 中断当前任务。 */
export async function interrupt(base, options = {}) {
  return request(base, '/interrupt', { method: 'POST', ...options })
}

/** POST /queue —— 清空等待队列。 */
export async function clearQueue(base, options = {}) {
  return request(base, '/queue', {
    method: 'POST',
    body: { clear: true },
    ...options,
  })
}

/** GET /view —— 取回输出 / 输入 / 临时文件的字节。 */
export async function viewFile(base, { filename, subfolder = '', type = 'output' }, options = {}) {
  if (typeof filename !== 'string' || filename === '' || filename.includes('..') || filename.includes('\0')) {
    throw new ComfyError('文件名不合法', { code: 'bad-file' })
  }
  if (typeof subfolder !== 'string' || subfolder.includes('..') || subfolder.includes('\0')) {
    throw new ComfyError('子目录不合法', { code: 'bad-file' })
  }
  const safeType = ['input', 'temp'].includes(type) ? type : 'output'
  const query = new URLSearchParams({ filename, subfolder, type: safeType })
  const response = await request(base, `/view?${query}`, { raw: true, ...options })
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType: response.headers.get('content-type') ?? 'application/octet-stream' }
}

/** POST /upload/image —— 上传本地图片，供 LoadImage 节点使用。 */
export async function uploadImage(base, name, bytes, options = {}) {
  const form = new FormData()
  const safe = safeFilename(name, 'upload.png')
  form.append('image', new Blob([bytes]), safe)
  form.append('type', 'input')
  const url = `${normalizeBase(base)}/upload/image`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      body: form,
      signal: withTimeout(options.timeout ?? 20_000, options.signal),
    })
  } catch (error) {
    throw new ComfyError(`上传图片失败：${error.message}`, { code: 'unreachable' })
  }
  if (!response.ok) {
    throw new ComfyError(`上传图片失败：HTTP ${response.status}`, { status: response.status, code: 'http' })
  }
  return response.json()
}

/** GET /userdata/workflows —— 列出 ComfyUI 里保存的工作流。部分版本返回 403，这里降级为空列表。 */
export async function workflows(base, options = {}) {
  try {
    const data = await request(base, '/userdata/workflows', options)
    if (Array.isArray(data)) return { items: data, warning: '' }
    if (data && typeof data === 'object') {
      const list = Array.isArray(data.workflows) ? data.workflows : Object.keys(data)
      return { items: list, warning: '' }
    }
    return { items: [], warning: '' }
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      return { items: [], warning: '此 ComfyUI 未开放工作流列表接口，可在「工作流」页手动载入 JSON 文件。' }
    }
    throw error
  }
}

// ---- 利用率采样：ComfyUI 的 /system_stats 只给显存/内存容量，不给 CPU/GPU 占用率，这里补上 ----

let cpuSample = null
/** 两次 os.cpus() 累计时间的差值算 CPU 占用率；首次无基准返回 null。 */
export function cpuUsagePercent() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const t = cpu.times ?? {}
    idle += Number(t.idle ?? 0)
    total += Number(t.user ?? 0) + Number(t.nice ?? 0) + Number(t.sys ?? 0) + Number(t.idle ?? 0) + Number(t.irq ?? 0)
  }
  const now = Date.now()
  if (!cpuSample) {
    cpuSample = { idle, total, at: now }
    return null
  }
  const deltaIdle = idle - cpuSample.idle
  const deltaTotal = total - cpuSample.total
  cpuSample = { idle, total, at: now }
  if (deltaTotal <= 0) return null
  return Math.max(0, Math.min(100, Math.round((1 - deltaIdle / deltaTotal) * 100)))
}

let gpuUsageCache = { at: 0, value: null }
/** 用 nvidia-smi 取 GPU 利用率；失败/无 N 卡时返回 null，前端会退回显示显存占用。 */
export function gpuUsagePercent() {
  const now = Date.now()
  if (now - gpuUsageCache.at < 1500) return Promise.resolve(gpuUsageCache.value)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      gpuUsageCache = { at: now, value }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 1200)
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 1000, windowsHide: true }, (error, stdout) => {
        clearTimeout(timer)
        if (error) return finish(null)
        const match = String(stdout ?? '').match(/\d+/)
        finish(match ? Math.max(0, Math.min(100, Number(match[0]))) : null)
      })
  })
}

/** 汇总状态卡片需要的全部信息。 */
export async function probe(base, options = {}) {
  const timeout = options.timeout ?? 8_000
  const [stats, queue, gpuUsage] = await Promise.all([
    systemStats(base, { timeout }),
    queueState(base, { timeout }).catch(() => ({ queue_running: [], queue_pending: [] })),
    gpuUsagePercent(),
  ])
  const system = stats?.system ?? {}
  return {
    version: system.comfyui_version ?? '',
    os: system.os ?? '',
    python: system.python_version ?? '',
    ramTotal: Number(system.ram_total ?? 0),
    ramFree: Number(system.ram_free ?? 0),
    devices: Array.isArray(stats?.devices) ? stats.devices : [],
    cpuUsage: cpuUsagePercent(),
    gpuUsage,
    queueRunning: Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0,
    queuePending: Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0,
    argv: Array.isArray(system.argv) ? system.argv : [],
  }
}

/** 从 status.messages 里提取 ComfyUI 的进度事件。 */
export function progressOf(record) {
  const messages = record?.status?.messages
  let value = 0
  let max = 0
  let node = ''
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!Array.isArray(message) || message[0] !== 'progress') continue
      const detail = message[1] ?? {}
      value = Number(detail.value ?? 0)
      max = Number(detail.max ?? 0)
      node = String(detail.node ?? '')
    }
  }
  const completed = record?.status?.completed === true || record?.status?.status_str === 'success'
  const failed = record?.status?.status_str === 'error'
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : completed ? 100 : 0
  return { value, max, node, percent, completed, failed }
}

export function safeFilename(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\0]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned === '' ? fallback : cleaned.slice(0, 180)
}

export function collectImages(record) {
  const images = []
  const outputs = record?.outputs
  if (!outputs || typeof outputs !== 'object') return images
  for (const [nodeId, output] of Object.entries(outputs)) {
    for (const image of output?.images ?? []) {
      images.push({
        nodeId: String(nodeId),
        filename: String(image.filename ?? ''),
        subfolder: String(image.subfolder ?? ''),
        type: String(image.type ?? 'output'),
      })
    }
  }
  return images
}
