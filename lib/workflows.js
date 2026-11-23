/** 自动发现本机 ComfyUI 保存的工作流。优先从磁盘扫描（ComfyUI 的 /userdata/workflows 常被 403 拒绝）。 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { systemStats, workflows } from './comfy.js'

const EXTENSIONS = new Set(['.json', '.jsonc'])
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_DEPTH = 3

function pushUnique(list, value) {
  const item = String(value ?? '').trim()
  if (item && !list.includes(item)) list.push(item)
}

function argvValue(argv, flag) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] ?? '')
    if (value === flag && argv[index + 1]) return String(argv[index + 1])
    if (value.startsWith(flag + '=')) return value.slice(flag.length + 1)
  }
  return ''
}

function normalizeDir(value) {
  const item = String(value ?? '').trim().replace(/^~(?=[\\/])/, os.homedir())
  return item ? path.resolve(item) : ''
}

/** 名字归一化：忽略空格、下划线、连字符、括号与大小写，便于 AI 传近似名字。 */
function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase()
    .replace(/[\s_\-—–·.、()（）[\]【】]/g, '')
}

const MODEL_PATTERNS = [
  [/sdxl|sd ?xl|illustrious/i, 'SDXL'],
  [/chroma/i, 'Chroma'],
  [/qwen/i, 'Qwen'],
  [/wan ?2\.?2|wan2/i, 'Wan2.2'],
  [/seedvr ?2/i, 'SeedVR2'],
  [/live ?portrait/i, 'LivePortrait'],
  [/sd ?1[._-]?5|sd15/i, 'SD15'],
  [/flux/i, 'FLUX'],
]

/**
 * 从工作流名字与节点类型推断用途，供 AI 自选时判断。
 * 返回 { purpose, model, needsSource, chinese, label }。
 */
export function classifyWorkflow(item) {
  const name = String(item?.name ?? '')
  const label = name.toLowerCase()
  const types = (Array.isArray(item?.types) ? item.types : []).map((type) => String(type))
  const hasType = (pattern) => types.some((type) => pattern.test(type))

  let purpose = '其他'
  // 注意顺序：图片放大/超分必须排在视频前，否则 SeedVR2_图片放大 会被 SeedVR2VideoUpscaler 节点误判成视频。
  if (/图片放大|图片超分|高清放大|image ?upscale/i.test(label)
    || (hasType(/^(LatentUpscaleBy|ImageUpscaleWithModel|Upscaler)$/i) && !/视频/.test(label))) {
    purpose = '高清放大'
  } else if (/动作|姿态|复刻|迁移|pose|openpose/i.test(label)
    || hasType(/^(SDPoseKeypointExtractor|SDPoseDrawKeypoints|LivePortrait\w*)$/i)) {
    // 名字含动作/姿态时优先于视频：动作复刻类工作流也带 VHS_LoadVideo，但用途是动作迁移。
    purpose = '动作姿态'
  } else if (/视频|video|wan2|seedvr2|动画/i.test(label)
    || hasType(/^(VHS_LoadVideo|LoadVideo|CreateVideo|WanImageToVideo|VideoCombine|SeedVR2VideoUpscaler)$/i)) {
    purpose = '视频'
  } else if (/放大|超分|upscale|4x/i.test(label)) {
    purpose = '高清放大'
  } else if (/重绘|涂抹|局部|inpaint|画笔|精修/i.test(label)
    || hasType(/^(VAEEncodeForInpaint|InpaintModelConditioning|EasyMaskPreview|Painter)$/i)) {
    purpose = '局部重绘'
  } else if (/图生图|img2img|image2image/i.test(label)) {
    purpose = '图生图'
  } else if (/文生图|txt2img|text2img/i.test(label)) {
    purpose = '文生图'
  } else if (types.length > 0 && !hasType(/^(LoadImage|VHS_LoadVideo|LoadVideo)$/i)) {
    purpose = '文生图'
  }

  const model = MODEL_PATTERNS.find(([pattern]) => pattern.test(name))?.[1] ?? ''
  const needsSource = hasType(/^(LoadImage|LoadImageBase64|VHS_LoadVideo|LoadVideo|ImageLoad)$/i)
  const chinese = /[\u4e00-\u9fa5]/.test(name)
  return { purpose, model, needsSource, chinese, label: `${purpose}${model ? ' · ' + model : ''}${needsSource ? ' · 需源图' : ''}` }
}

/**
 * 按用途挑一个最合适的工作流（给 AI 自选用）。找不到返回 null。
 * 中文提示词优先中文工作流；模型偏好 SDXL > Chroma > Qwen > SD15。
 */
export function pickWorkflow(items, options = {}) {
  const purpose = String(options.purpose ?? '文生图')
  const chinese = Boolean(options.chinese)
  const model = String(options.model ?? '').trim().toLowerCase()
  const requireNoSource = Boolean(options.requireNoSource)
  const candidates = (Array.isArray(items) ? items : [])
    .map((item) => ({ item, info: classifyWorkflow(item) }))
    .filter(({ info }) => info.purpose === purpose && (!requireNoSource || !info.needsSource))
  if (candidates.length === 0) return null

  const preferred = ['SDXL', 'Chroma', 'Qwen', 'SD15']
  const scored = candidates.map(({ item, info }) => {
    let score = 0
    // 名字里明确带「中文」的工作流对中文提示词更友好（ZHTranslate 节点）。
    const zhSpecialized = /中文/.test(item.name)
    if (chinese && zhSpecialized) score += 12
    else if (chinese && info.chinese) score += 6
    else if (!chinese && zhSpecialized) score -= 6
    if (model && info.model.toLowerCase() === model) score += 8
    const rank = preferred.indexOf(info.model)
    if (rank >= 0) score += (preferred.length - rank) * 0.5
    return { name: item.name, info, score }
  })
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'))
  const best = scored[0]
  return {
    name: best.name,
    purpose: best.info.purpose,
    model: best.info.model,
    chinese: best.info.chinese,
    reason: best.info.label + (chinese && best.info.chinese ? ' · 适配中文提示词' : ''),
  }
}

/** 候选目录：显式配置 > ComfyUI 启动参数推导 > 常见默认位置。 */
export async function workflowDirs(base, options = {}) {
  const dirs = []
  for (const dir of options.dirs ?? []) pushUnique(dirs, normalizeDir(dir))

  let argv = []
  try {
    const stats = await systemStats(base, { timeout: options.timeout ?? 5_000 })
    argv = stats?.system?.argv ?? []
  } catch { /* ComfyUI 暂时不可用时，仍可用下面的默认目录 */ }

  const userDir = argvValue(argv, '--user-directory') || process.env.COMFYUI_USER_DIRECTORY || ''
  const user = argvValue(argv, '--user') || 'default'
  if (userDir) pushUnique(dirs, path.join(normalizeDir(userDir), 'workflows'))

  const outputDir = argvValue(argv, '--output-directory') || ''
  if (outputDir) {
    const root = path.dirname(normalizeDir(outputDir))
    pushUnique(dirs, path.join(root, 'user', user, 'workflows'))
  }

  if (process.env.DSH_COMFYUI_WORKFLOWS) pushUnique(dirs, path.resolve(process.env.DSH_COMFYUI_WORKFLOWS))
  pushUnique(dirs, path.join(os.homedir(), 'Documents', 'ComfyUI', 'user', 'default', 'workflows'))
  pushUnique(dirs, path.join(os.homedir(), 'ComfyUI', 'user', 'default', 'workflows'))

  // 排除不存在的目录，并去掉重复（Windows 路径大小写不敏感）。
  const seen = new Set()
  const result = []
  for (const dir of dirs) {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const stat = await fs.stat(dir)
      if (stat.isDirectory()) result.push(dir)
    } catch { /* skip */ }
  }
  return result
}

function looksLikeWorkflow(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false
  if (Array.isArray(document.nodes) && Array.isArray(document.links)) return true
  if (document.prompt && typeof document.prompt === 'object' && !Array.isArray(document.nodes)) return true
  const values = Object.values(document)
  return values.length > 0 && values.every((node) => node && typeof node === 'object' && typeof node.class_type === 'string')
}

async function scanDir(dir, items, seen, depth = 0) {
  if (depth > MAX_DEPTH || items.length >= 500) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === '__manager' || entry.name === 'node_modules') continue
      await scanDir(full, items, seen, depth + 1)
      continue
    }
    if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    if (seen.has(path.resolve(full))) continue
    try {
      const stat = await fs.stat(full)
      if (stat.size > MAX_FILE_BYTES) continue
      const document = JSON.parse(await fs.readFile(full, 'utf8'))
      if (!looksLikeWorkflow(document)) continue
      const nodes = Array.isArray(document.nodes) ? document.nodes : []
      const prompt = document.prompt && typeof document.prompt === 'object' ? document.prompt : null
      const types = nodes.length
        ? nodes.map((node) => node?.type).filter(Boolean)
        : prompt ? Object.values(prompt).map((node) => node?.class_type).filter(Boolean) : []
      const item = {
        name: path.basename(entry.name, path.extname(entry.name)),
        file: entry.name,
        path: path.resolve(full),
        nodeCount: nodes.length || Object.keys(prompt ?? {}).length,
        types: [...new Set(types)].slice(0, 8),
        modified: stat.mtimeMs,
      }
      seen.add(item.path)
      items.push(item)
    } catch { /* 跳过损坏或无法读取的文件 */ }
  }
}

/** 返回 { items, source, warning, dirs }。 */
export async function listWorkflows(base, options = {}) {
  const dirs = await workflowDirs(base, options)
  const items = []
  const seen = new Set()
  for (const dir of dirs) await scanDir(dir, items, seen)
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  if (items.length > 0) {
    return { items, source: 'disk', dirs, warning: '' }
  }

  // 磁盘没找到时退回 ComfyUI 接口（部分版本会 403）。
  try {
    const result = await workflows(base, { timeout: options.timeout ?? 5_000 })
    const names = (result.items ?? []).map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
    return {
      items: names.map((name) => ({ name, file: name, path: '', nodeCount: 0, types: [] })),
      source: 'api',
      dirs,
      warning: names.length ? result.warning ?? '' : '没有找到已保存的工作流。请在 ComfyUI 里点「保存工作流」，或手动载入 JSON 文件。',
    }
  } catch (error) {
    return { items: [], source: 'none', dirs, warning: `扫描工作流失败：${error?.message ?? String(error)}` }
  }
}

function insideDirs(target, dirs) {
  const resolved = path.resolve(target)
  return dirs.some((dir) => {
    const relative = path.relative(dir, resolved)
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  })
}

/** 解析工作流目标路径：名称按已发现目录查找，绝对路径必须在目录内。 */
async function resolveWorkflowTarget(base, options, nameOrPath) {
  const requested = String(nameOrPath ?? '').trim()
  if (!requested) throw new Error('缺少工作流名称')
  // 空数组表示「未配置」，必须回退到自动推导；不能用 ??（空数组非 null）。
  const configured = Array.isArray(options?.dirs) ? options.dirs : null
  const dirs = configured && configured.length > 0 ? configured : await workflowDirs(base, options)

  let target = ''
  if (path.isAbsolute(requested) || requested.startsWith('.') || requested.includes('/') || requested.includes('\\')) {
    target = path.resolve(requested)
  } else {
    // 先精确匹配文件名。
    for (const dir of dirs) {
      for (const extension of EXTENSIONS) {
        const candidate = path.join(dir, requested + extension)
        try {
          await fs.access(candidate)
          target = candidate
          break
        } catch { /* try next */ }
      }
      if (target) break
    }
    // 容错：AI 给的名字可能少了下划线/空格或大小写不同（如「SD15文生图」→「SD15_文生图」）。
    if (!target) {
      const wanted = normalizeName(requested)
      if (wanted) {
        const scanned = await listWorkflows(base, options)
        // 同名工作流可能存在于多个目录，按名字去重后再判断，避免误报「匹配到多个」。
        const byName = new Map()
        for (const item of scanned.items) {
          if (!byName.has(item.name)) byName.set(item.name, item)
        }
        const matches = [...byName.values()].filter((item) => {
          const normalized = normalizeName(item.name)
          return normalized === wanted || (!wanted.includes(normalized) && normalized.includes(wanted))
        })
        if (matches.length === 1) target = matches[0].path
        else if (matches.length > 1) {
          throw new Error(`工作流名「${requested}」匹配到多个：${matches.map((item) => item.name).join('、')}。请给出更完整的名字`)
        }
      }
    }
  }
  if (!target) throw new Error(`找不到工作流：${requested}`)
  if (!insideDirs(target, dirs)) throw new Error('工作流路径不在允许的目录内')
  if (!EXTENSIONS.has(path.extname(target).toLowerCase())) throw new Error('只允许写 .json / .jsonc 工作流文件')
  return { target, name: path.basename(target, path.extname(target)), dirs }
}

function revisionOf(stat) {
  return String(stat.mtimeMs) + ':' + String(stat.size)
}

/** 按名称或绝对路径读取工作流文档，路径必须位于已发现的目录内。 */
export async function readWorkflow(base, options, nameOrPath) {
  const { target, name } = await resolveWorkflowTarget(base, options, nameOrPath)
  const document = JSON.parse(await fs.readFile(target, 'utf8'))
  if (!looksLikeWorkflow(document)) throw new Error('这个文件不是 ComfyUI 工作流 JSON')
  return { document, name, path: target }
}

/** 文件版本号：DSH 写回后记录，ComfyUI 保存后变化，用于双向同步轮询。 */
export async function workflowRevision(base, options, nameOrPath) {
  const { target, name } = await resolveWorkflowTarget(base, options, nameOrPath)
  const stat = await fs.stat(target)
  return { name, path: target, modified: stat.mtimeMs, size: stat.size, revision: revisionOf(stat) }
}

/**
 * 原子写回工作流。mutate(document) 直接修改从磁盘读到的原始画布文档
 * （保留 ComfyUI 的 nodes/links/groups 等字段），返回修改结果。
 */
export async function writeWorkflow(base, options, nameOrPath, mutate) {
  const { target, name } = await resolveWorkflowTarget(base, options, nameOrPath)
  const current = JSON.parse(await fs.readFile(target, 'utf8'))
  if (!looksLikeWorkflow(current)) throw new Error('这个文件不是 ComfyUI 工作流 JSON')
  const next = typeof mutate === 'function' ? mutate(current) : mutate
  if (!looksLikeWorkflow(next)) throw new Error('写回后的数据不是合法工作流')
  const text = JSON.stringify(next, null, 2)
  const tmp = target + '.dsh-' + process.pid + '.tmp'
  await fs.writeFile(tmp, text, 'utf8')
  try {
    await fs.rename(tmp, target)
  } catch (error) {
    await fs.rm(target, { force: true })
    await fs.rename(tmp, target)
  }
  const stat = await fs.stat(target)
  return { name, path: target, document: next, modified: stat.mtimeMs, size: stat.size, revision: revisionOf(stat) }
}
