/** DSH → ComfyUI 画布桥接：调用 ComfyUI 自定义节点 dsh_desk_bridge 的本地 HTTP 接口。 */

import { normalizeBase } from './comfy.js'

const TIMEOUT_MS = 2000

async function callBridge(base, suffix, options = {}) {
  const url = normalizeBase(base) + '/dsh_desk_bridge/' + suffix
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error ?? 'HTTP ' + response.status)
  return data
}

/** 探测桥接扩展是否已安装（ComfyUI 需要重启才会加载新扩展）。 */
export async function bridgeStatus(base) {
  try {
    const data = await callBridge(base, 'status')
    return { installed: true, version: String(data?.version ?? ''), base: normalizeBase(base) }
  } catch (error) {
    return { installed: false, version: '', base: normalizeBase(base), warning: error?.message ?? String(error) }
  }
}

/**
 * 把画布变更推给 ComfyUI 前端（由其 websocket 广播实现实时同步）。
 * 推送失败不影响 DSH 写回磁盘，所以这里只返回状态、不抛错。
 */
export async function pushToComfy(base, payload) {
  try {
    await callBridge(base, 'apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, warning: error?.message ?? String(error) }
  }
}
