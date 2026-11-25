/** DSH Host 侧 HTTP 路由：浏览器面板通过同源 fetch 调用这些端点，由 Host 代理访问本地 ComfyUI。 */

import { Buffer } from 'node:buffer'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ComfyError,
  clearQueue,
  collectImages,
  history,
  historyOne,
  interrupt,
  normalizeBase,
  objectInfo,
  probe,
  progressOf,
  queueState,
  submitPrompt,
  uploadImage,
  viewFile,
  workflows,
  safeFilename,
} from './comfy.js'
import { applyOverrides, buildTxt2Img, describeMapping, extractParams, parseWorkflowDocument, sanitizePrompt } from './graph.js'
import { deleteImage, listImages, openFolder, readImage, resolveLibraryDir, saveImage } from './store.js'
import { listWorkflows, readWorkflow, writeWorkflow, workflowRevision } from './workflows.js'
import { applyCanvasEdit } from './workflow-edit.js'
import { bridgeStatus, pushToComfy } from './bridge.js'
import { listChatModels, writePromptWith } from './llm.js'

const PREFIX = '/api/dsh-comfyui-desk'
const MAX_BODY_BYTES = 16 * 1024 * 1024

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

function sendJson(res, status, value) {
  if (res.writableEnded) return
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

function sendBytes(res, status, bytes, contentType) {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': contentType ?? 'application/octet-stream', 'content-length': bytes.length })
  res.end(bytes)
}

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' }
const mimeOfName = (name) => IMAGE_MIME[String(name).split('.').pop().toLowerCase()] ?? 'application/octet-stream'

const OUTPUT_DIR_CACHE = { at: 0, dirs: [] }

/** ComfyUI 的输出目录：配置优先，其次自动探测常见安装位置（ComfyUI 关掉时照样能读盘）。 */
function candidateOutputDirs(cfg) {
  if (Date.now() - OUTPUT_DIR_CACHE.at < 60_000) return OUTPUT_DIR_CACHE.dirs
  const dirs = new Set()
  const add = (value) => { if (value) dirs.add(path.resolve(String(value))) }
  add(cfg?.outputDir)
  const home = os.homedir()
  const user = path.basename(home)
  add(path.join(home, 'Documents', 'ComfyUI', 'output'))
  add(path.join(home, 'ComfyUI', 'output'))
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
    if (!existsSync(drive + ':\\')) continue
    add(`${drive}:\\Users\\${user}\\Documents\\ComfyUI\\output`)
    add(`${drive}:\\ComfyUI\\output`)
    add(`${drive}:\\ComfyUI_windows_portable\\ComfyUI\\output`)
    add(`${drive}:\\AI\\ComfyUI\\output`)
    try {
      for (const entry of readdirSync(`${drive}:\\`, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/comfy/i.test(entry.name)) continue
        add(`${drive}:\\${entry.name}\\output`)
        add(`${drive}:\\${entry.name}\\ComfyUI\\output`)
      }
    } catch { /* 无权限的盘直接跳过 */ }
  }
  OUTPUT_DIR_CACHE.at = Date.now()
  OUTPUT_DIR_CACHE.dirs = [...dirs].filter((dir) => existsSync(dir))
  return OUTPUT_DIR_CACHE.dirs
}

function fail(res, error) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { ok: false, error: error.message, ...error.extra })
    return
  }
  if (error instanceof ComfyError) {
    const status = error.status ?? (error.code === 'unreachable' || error.code === 'timeout' ? 503 : 502)
    sendJson(res, status, { ok: false, error: error.message, code: error.code })
    return
  }
  console.error('[dsh-comfyui-desk] 未处理的错误:', error)
  sendJson(res, 500, { ok: false, error: `内部错误：${error?.message ?? String(error)}` })
}

function guard(req, res) {
  const remote = String(req.socket?.remoteAddress ?? '')
  const local = remote === '' || remote === '::1' || remote === '127.0.0.1' || remote.endsWith('127.0.0.1')
  if (!local) {
    sendJson(res, 403, { ok: false, error: '只允许本机访问插件接口' })
    return false
  }
  return true
}

function requireMethod(req, res, method) {
  if (String(req.method ?? '').toUpperCase() === method) return true
  sendJson(res, 405, { ok: false, error: `需要 ${method} 请求` })
  return false
}

async function readBuffer(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大（上限 16 MB）')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const buffer = await readBuffer(req)
  if (buffer.length === 0) return {}
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

function queryOf(req) {
  const raw = String(req.url ?? '').split('?')[1] ?? ''
  return new URLSearchParams(raw)
}

function baseOf(req, config) {
  const queryBase = queryOf(req).get('base')
  return normalizeBase(queryBase || config.baseUrl || 'http://127.0.0.1:8188')
}

/**
 * 一个 exact path 只能注册一次（DSH webServer 按 path 去重）。
 * 需要同路径多 method 时用 routeMethods 合并到一个 handler 里分发。
 */
function routeMethods(pathname, methods, handler) {
  const allowed = (Array.isArray(methods) ? methods : [methods]).map((value) => String(value).toUpperCase())
  return {
    kind: 'exact',
    path: `${PREFIX}${pathname}`,
    handler: (req, res) => {
      void (async () => {
        if (!guard(req, res)) return
        const actual = String(req.method ?? '').toUpperCase()
        if (!allowed.includes(actual)) {
          sendJson(res, 405, { ok: false, error: `需要 ${allowed.join(' / ')} 请求` })
          return
        }
        try {
          await handler(req, res)
        } catch (error) {
          fail(res, error)
        }
      })()
    },
  }
}

function route(pathname, method, handler) {
  return routeMethods(pathname, method, handler)
}

/**
 * webServer 的 exact 路由不会自动经过 DSH 的准入层，这里主动调 connection.requestRejection。
 * 平台没有该服务（<0.2.3）或调用异常时放行，避免一次平台 API 变动把插件弄挂。
 */
function withAdmission(ctx, handler) {
  return (req, res) => {
    void (async () => {
      let status = 0
      try {
        const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : null
        if (connection && typeof connection.requestRejection === 'function') {
          const rejection = await connection.requestRejection(req)
          const raw = rejection !== null && typeof rejection === 'object'
            ? (rejection.status ?? rejection.rejection)
            : rejection
          const code = Number(raw)
          if (Number.isInteger(code) && code > 0) status = code
        }
      } catch {
        status = 0
      }
      if (status) {
        sendJson(res, status, {
          ok: false,
          error: status === 401 ? '缺少或过期的 DSH 会话凭据' : '请求未通过 DSH 准入检查',
        })
        return
      }
      handler(req, res)
    })()
  }
}

/** AI 提示词：用 DSH 模型库里选中的模型（默认当前会话模型）写提示词。 */
async function writePrompt(ctx, config, args) {
  try {
    const prompt = await writePromptWith(ctx, args, {
      configProvider: config.llmProvider,
      configModel: config.llmModel,
    })
    return { ok: true, prompt }
  } catch (error) {
    throw new HttpError(error?.status ?? 502, error?.message ?? String(error))
  }
}

export function makeRoutes(ctx, config = {}) {
  const cfg = config ?? {}

  const status = route('/status', 'GET', async (req, res) => {
    const base = baseOf(req, cfg)
    const data = await probe(base, { timeout: Number(cfg.requestTimeoutMs ?? 10_000) })
    sendJson(res, 200, { ok: true, baseUrl: base, libraryDir: resolveLibraryDir(cfg), ...data })
  })

  const configRoute = route('/config', 'GET', async (_req, res) => {
    sendJson(res, 200, {
      ok: true,
      baseUrl: normalizeBase(cfg.baseUrl ?? 'http://127.0.0.1:8188'),
      libraryDir: resolveLibraryDir(cfg),
      llmProvider: String(cfg.llmProvider ?? ''),
      llmModel: String(cfg.llmModel ?? ''),
      workflowDirs: Array.isArray(cfg.workflowDirs) ? cfg.workflowDirs.map(String) : [],
    })
  })

  const models = route('/models', 'GET', async (req, res) => {
    const info = await objectInfo(baseOf(req, cfg), { force: queryOf(req).get('force') === '1' })
    const pick = (type, input) => {
      const list = info?.[type]?.input?.required?.[input]?.[0]
      return Array.isArray(list) ? list.map(String) : []
    }
    sendJson(res, 200, {
      ok: true,
      checkpoints: pick('CheckpointLoaderSimple', 'ckpt_name'),
      samplers: pick('KSampler', 'sampler_name'),
      schedulers: pick('KSampler', 'scheduler'),
      loras: pick('LoraLoader', 'lora_name'),
      nodeCount: Object.keys(info ?? {}).length,
    })
  })

  const objectInfoRoute = route('/object-info', 'GET', async (req, res) => {
    const info = await objectInfo(baseOf(req, cfg))
    sendJson(res, 200, { ok: true, objectInfo: info })
  })

  const workflowList = route('/workflows', 'GET', async (req, res) => {
    const result = await listWorkflows(baseOf(req, cfg), {
      dirs: cfg.workflowDirs,
      timeout: Number(cfg.requestTimeoutMs ?? 10_000),
    })
    sendJson(res, 200, { ok: true, ...result })
  })

  const workflowFile = route('/workflow-file', 'GET', async (req, res) => {
    const base = baseOf(req, cfg)
    const name = queryOf(req).get('name') ?? ''
    let data
    try {
      data = await readWorkflow(base, { dirs: cfg.workflowDirs }, name)
    } catch (error) {
      throw new HttpError(400, `读取工作流失败：${error?.message ?? String(error)}`)
    }
    const info = await objectInfo(base).catch(() => ({}))
    const parsed = parseWorkflowDocument(data.document, info)
    const stat = await workflowRevision(base, { dirs: cfg.workflowDirs }, name).catch(() => null)
    // document 供前端画布编辑后写回；revision 供双向同步轮询比对。
    sendJson(res, 200, { ok: true, name: data.name, path: data.path, document: data.document, revision: stat?.revision ?? '', ...parsed })
  })

  const parseWorkflow = route('/parse-workflow', 'POST', async (req, res) => {
    const body = await readJson(req)
    const info = await objectInfo(baseOf(req, cfg)).catch(() => ({}))
    const parsed = parseWorkflowDocument(body.document, info)
    sendJson(res, 200, { ok: true, ...parsed })
  })

  // 双向同步：DSH 画布改节点/控件 → 写回磁盘 → 推给 ComfyUI 前端实时应用。
  const workflowApply = route('/workflow-apply', 'POST', async (req, res) => {
    const body = await readJson(req)
    const name = String(body.name ?? '')
    if (!name) throw new HttpError(400, '缺少工作流名称')
    const base = baseOf(req, cfg)
    const edit = body.edit ?? body
    let written
    try {
      written = await writeWorkflow(base, { dirs: cfg.workflowDirs }, name, (document) => applyCanvasEdit(document, edit))
    } catch (error) {
      throw new HttpError(400, `写回工作流失败：${error?.message ?? String(error)}`)
    }
    const push = body.sync === false
      ? { ok: true, skipped: true }
      : await pushToComfy(base, { ...edit, name: written.name, path: written.path, graph: written.document })
    const info = await objectInfo(base).catch(() => ({}))
    const parsed = parseWorkflowDocument(written.document, info)
    sendJson(res, 200, { ok: true, name: written.name, revision: written.revision, push, ...parsed })
  })

  const workflowSave = route('/workflow-save', 'POST', async (req, res) => {
    const body = await readJson(req)
    const name = String(body.name ?? '')
    if (!name || !body.document || typeof body.document !== 'object') throw new HttpError(400, '需要 name 与 document')
    const base = baseOf(req, cfg)
    let written
    try {
      written = await writeWorkflow(base, { dirs: cfg.workflowDirs }, name, () => body.document)
    } catch (error) {
      throw new HttpError(400, `保存工作流失败：${error?.message ?? String(error)}`)
    }
    const push = body.sync === false
      ? { ok: true, skipped: true }
      : await pushToComfy(base, { op: 'load', graph: written.document, name: written.name, path: written.path })
    sendJson(res, 200, { ok: true, name: written.name, revision: written.revision, push })
  })

  const workflowRevisionRoute = route('/workflow-revision', 'GET', async (req, res) => {
    const name = queryOf(req).get('name') ?? ''
    if (!name) throw new HttpError(400, '缺少 name 参数')
    const data = await workflowRevision(baseOf(req, cfg), { dirs: cfg.workflowDirs }, name)
    sendJson(res, 200, { ok: true, ...data })
  })

  const bridge = route('/bridge-status', 'GET', async (req, res) => {
    sendJson(res, 200, { ok: true, ...(await bridgeStatus(baseOf(req, cfg))) })
  })

  const run = route('/run', 'POST', async (req, res) => {
    const body = await readJson(req)
    const base = baseOf(req, cfg)
    const info = await objectInfo(base).catch(() => ({}))
    let prompt = body.prompt
    let warnings = []
    if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) {
      prompt = buildTxt2Img(info, body.params ?? {})
      warnings.push('未提供工作流，已使用内置文生图模板')
    }
    const cleaned = sanitizePrompt(prompt, info)
    warnings.push(...cleaned.warnings)
    const applied = applyOverrides(cleaned.prompt, body.params ?? {}, body.overrides ?? {})
    const submitted = await submitPrompt(base, applied.prompt, `dsh-comfyui-desk-${process.pid}`)
    sendJson(res, 200, {
      ok: true,
      promptId: submitted?.prompt_id ?? '',
      number: submitted?.number ?? 0,
      nodeErrors: submitted?.node_errors ?? {},
      applied: applied.applied,
      warnings: [...warnings, ...applied.warnings],
    })
  })

  const progress = route('/progress', 'GET', async (req, res) => {
    const promptId = queryOf(req).get('promptId') ?? ''
    if (promptId === '') throw new HttpError(400, '缺少 promptId 参数')
    const base = baseOf(req, cfg)
    const [record, queue] = await Promise.all([
      historyOne(base, promptId),
      queueState(base).catch(() => ({ queue_running: [], queue_pending: [] })),
    ])
    const state = progressOf(record?.[promptId] ?? record)
    const pendingIndex = (queue?.queue_pending ?? []).findIndex((item) => Array.isArray(item) && item[1] === promptId)
    sendJson(res, 200, {
      ok: true,
      promptId,
      ...state,
      queuePosition: pendingIndex >= 0 ? pendingIndex + 1 : 0,
      outputs: record ? collectImages(record?.[promptId] ?? record) : [],
    })
  })

  const stop = route('/interrupt', 'POST', async (req, res) => {
    await interrupt(baseOf(req, cfg))
    sendJson(res, 200, { ok: true })
  })

  const clear = route('/clear-queue', 'POST', async (req, res) => {
    await clearQueue(baseOf(req, cfg))
    sendJson(res, 200, { ok: true })
  })

  const recent = route('/history', 'GET', async (req, res) => {
    const limit = Number.parseInt(queryOf(req).get('limit') ?? '20', 10)
    const records = await history(baseOf(req, cfg), Number.isFinite(limit) ? limit : 20)
    const runs = records.map((record) => ({
      id: record.id,
      number: record?.prompt?.[0] ?? 0,
      ...progressOf(record),
      images: collectImages(record),
      prompt: record?.prompt?.[2] ?? null,
    }))
    sendJson(res, 200, { ok: true, runs })
  })

  const view = route('/view', 'GET', async (req, res) => {
    const query = queryOf(req)
    const filename = query.get('filename') ?? ''
    try {
      const result = await viewFile(baseOf(req, cfg), {
        filename,
        subfolder: query.get('subfolder') ?? '',
        type: query.get('type') ?? 'output',
      })
      sendBytes(res, 200, result.buffer, result.contentType)
    } catch (error) {
      // ComfyUI 没开时按文件名回到磁盘：先图片库，再自动探测的 ComfyUI 输出目录。
      const base = String(filename).split(/[\\/]/).pop() ?? ''
      if (!base || base.includes('..')) throw error
      try {
        const local = await readImage(cfg, base)
        sendBytes(res, 200, local.bytes, mimeOfName(base))
        return
      } catch { /* 继续找输出目录 */ }
      const subfolder = String(query.get('subfolder') ?? '').replace(/^[\\/]+|[\\/]+$/g, '')
      const rel = subfolder !== '' && !subfolder.includes('..') ? path.join(subfolder, base) : base
      for (const dir of candidateOutputDirs(cfg)) {
        for (const candidate of rel === base ? [base] : [rel, base]) {
          try {
            const bytes = await readFile(path.join(dir, candidate))
            sendBytes(res, 200, bytes, mimeOfName(base))
            return
          } catch { /* 换下一个 */ }
        }
      }
      throw error
    }
  })

  const upload = route('/upload', 'POST', async (req, res) => {
    const type = String(req.headers['content-type'] ?? '')
    if (!type.includes('multipart/form-data')) throw new HttpError(400, '需要 multipart/form-data 上传')
    const buffer = await readBuffer(req)
    const form = await new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': type },
      body: buffer,
    }).formData()
    const file = form.get('image')
    if (!file || typeof file === 'string') throw new HttpError(400, '缺少 image 文件字段')
    const bytes = Buffer.from(await file.arrayBuffer())
    const result = await uploadImage(baseOf(req, cfg), safeFilename(file.name, 'upload.png'), bytes)
    sendJson(res, 200, { ok: true, name: result?.name ?? safeFilename(file.name, 'upload.png'), subfolder: result?.subfolder ?? '' })
  })

  const library = route('/images', 'GET', async (req, res) => {
    const query = queryOf(req)
    const limit = Number.parseInt(query.get('limit') ?? '60', 10)
    const override = query.get('dir') ?? ''
    const images = await listImages(cfg, Number.isFinite(limit) ? limit : 60, override)
    sendJson(res, 200, { ok: true, images, dir: resolveLibraryDir(cfg, override) })
  })

  // 用系统文件管理器打开图库目录，方便用户直接整理文件。
  const libraryOpen = route('/library-open', 'POST', async (req, res) => {
    const body = await readJson(req)
    const dir = String(body.dir ?? '').trim() || resolveLibraryDir(cfg)
    sendJson(res, 200, await openFolder(dir))
  })

  const save = route('/save-image', 'POST', async (req, res) => {
    const body = await readJson(req)
    if (typeof body.filename !== 'string' || body.filename === '') throw new HttpError(400, '缺少 filename')
    const result = await viewFile(baseOf(req, cfg), {
      filename: body.filename,
      subfolder: body.subfolder ?? '',
      type: body.type ?? 'output',
    })
    const suggestion = body.name || body.filename.replace(/\.[^.]+$/, '')
    const saved = await saveImage(cfg, result.buffer, String(suggestion), String(body.dir ?? ''))
    sendJson(res, 200, { ok: true, ...saved })
  })

  // GET 与 DELETE 共用同一个 exact path，必须合并注册，否则 DSH 会报 duplicate exact route。
  const libraryFile = routeMethods('/library-file', ['GET', 'DELETE'], async (req, res) => {
    const query = queryOf(req)
    const name = query.get('name') ?? ''
    const dir = query.get('dir') ?? ''
    if (String(req.method ?? '').toUpperCase() === 'DELETE') {
      sendJson(res, 200, { ok: true, ...(await deleteImage(cfg, name, dir)) })
      return
    }
    const image = await readImage(cfg, name, dir)
    const extension = name.toLowerCase().split('.').pop()
    const mime = extension === 'jpg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp'
      : extension === 'gif' ? 'image/gif' : extension === 'bmp' ? 'image/bmp' : 'image/png'
    sendBytes(res, 200, image.bytes, mime)
  })

  const promptAssist = route('/prompt-assist', 'POST', async (req, res) => {
    const body = await readJson(req)
    sendJson(res, 200, await writePrompt(ctx, cfg, body))
  })

  // DSH 模型库：给前端设置面板下拉选择 AI 模型，默认值为当前会话模型。
  const llmModels = route('/llm-models', 'GET', async (_req, res) => {
    try {
      sendJson(res, 200, { ok: true, ...(await listChatModels(ctx)) })
    } catch (error) {
      sendJson(res, 200, { ok: false, groups: [], default: { provider: '', model: '' }, warning: error?.message ?? String(error) })
    }
  })

  const routes = [
    status, configRoute, models, objectInfoRoute, workflowList, workflowFile, parseWorkflow,
    workflowApply, workflowSave, workflowRevisionRoute, bridge, run, progress,
    stop, clear, recent, view, upload, library, libraryOpen, save, libraryFile, promptAssist, llmModels,
  ]
  // DSH 桌面版把 dsh-resource://app 下的请求转发给 Host。不同版本对 /api 前缀的处理不一致，
  // 同一 handler 再挂一份无 /api 前缀的别名，浏览器侧可自动回退。
  return routes.concat(routes.map((item) => ({ ...item, path: item.path.replace(/^\/api/, '') })))
    .map((item) => ({ ...item, handler: withAdmission(ctx, item.handler) }))
}
