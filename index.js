/**
 * dsh-comfyui-desk —— DSH Host 入口。
 * 注册 /api/dsh-comfyui-desk/* 同源路由（给侧边栏面板用）和 7 个 Agent 工具。
 * 不 import 任何 @deepseek-ai/* 包，避免宿主树解析差异导致加载失败。
 */

import { makeRoutes } from './lib/routes.js'
import { registerTools } from './lib/tools.js'

export const name = 'dsh-comfyui-desk'
export const inject = ['webServer', 'tools']

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8188',
  requestTimeoutMs: 10_000,
  libraryDir: '',
  llmProvider: '',
  llmModel: '',
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }

  ctx.effect(() => {
    const disposers = makeRoutes(ctx, cfg).map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* ignore */ }
      }
    }
  }, 'dsh-comfyui-desk: /api/dsh-comfyui-desk routes')

  ctx.effect(() => registerTools(ctx, cfg), 'dsh-comfyui-desk: agent tools')
}
