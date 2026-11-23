/**
 * 工作流图转换与节点映射。
 * - UI 格式（ComfyUI 画布保存的 nodes/links）→ API 格式（/prompt 需要的 prompt）
 * - prompt → 人类可读的节点映射（供侧边栏查看 / 改参数）
 * - 内置文生图模板（没有工作流时也能直接生成）
 */

import { ComfyError, safeFilename } from './comfy.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'

// ComfyUI 画布里的“纯界面节点”，后端 /prompt 不认识；直接提交会 400 missing_node_type。
// Reroute 是单输入直通节点，移除后要把下游连线接到它的上游。
const UI_ONLY_TYPES = new Set(['Note', 'Reroute', 'PrimitiveNode'])
// KSampler/KSamplerAdvanced 在 seed 后有一个画布专用 widget（后端 schema 里没有），
// 不同步跳过它会导致 steps/cfg/sampler_name 等参数整体错位一位。
const SEED_CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize'])

function firstOption(objectInfo, classType, inputName, fallback = '') {
  const spec = objectInfo?.[classType]?.input?.required?.[inputName]
    ?? objectInfo?.[classType]?.input?.optional?.[inputName]
  const list = Array.isArray(spec) ? spec[0] : undefined
  return Array.isArray(list) && list.length > 0 ? String(list[0]) : fallback
}

/** 用 object_info 构造一份标准文生图 API 图。 */
export function buildTxt2Img(objectInfo, params = {}) {
  if (!isObject(objectInfo)) throw new ComfyError('拿不到 /object_info，无法构造工作流', { code: 'no-object-info' })
  const checkpoints = firstOption(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name', '')
  if (checkpoints === '') throw new ComfyError('ComfyUI 里没有可用的 checkpoint', { code: 'no-checkpoint' })
  const sampler = firstOption(objectInfo, 'KSampler', 'sampler_name', 'euler')
  const scheduler = firstOption(objectInfo, 'KSampler', 'scheduler', 'normal')
  const positive = String(params.positive ?? '')
  const negative = String(params.negative ?? '')
  const width = clampInt(params.width, 64, 4096, 1024)
  const height = clampInt(params.height, 64, 4096, 1024)
  const steps = clampInt(params.steps, 1, 1000, 28)
  const cfg = clampNumber(params.cfg, 0, 100, 7)
  const batch = clampInt(params.batch, 1, 16, 1)
  const seed = randomSeed(params.seed)
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: String(params.checkpoint || checkpoints) } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: batch } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: clampNumber(params.denoise, 0, 1, 1),
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: safeFilename(params.filenamePrefix || 'DSHDesk', 'DSHDesk'), images: ['6', 0] } },
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function randomSeed(value) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
  const seed = Math.floor(Math.random() * 4_294_967_295)
  return seed
}

/** UI 格式 → API 格式。只做结构转换，不改语义。 */
export function uiToPrompt(graph, objectInfo) {
  if (!isObject(graph) || !Array.isArray(graph.nodes)) {
    throw new ComfyError('不是 ComfyUI 画布格式的工作流（缺少 nodes 数组）', { code: 'bad-workflow' })
  }
  const linkMap = new Map()
  for (const link of graph.links ?? []) {
    if (Array.isArray(link) && link.length >= 5) linkMap.set(String(link[0]), [String(link[1]), Number(link[2])])
  }
  const warnings = []
  const prompt = {}
  for (const node of graph.nodes) {
    if (!isObject(node) || node.type === undefined) continue
    if (node.mode === 2) {
      warnings.push(`节点 ${node.id}（${node.type}）已静音，提交时跳过`)
      continue
    }
    if (node.mode === 4) {
      warnings.push(`节点 ${node.id}（${node.type}）被旁通，未自动重接连线，提交时跳过`)
      continue
    }
    const spec = objectInfo?.[node.type]?.input
    const order = [
      ...(Array.isArray(spec?.input_order?.required) ? spec.input_order.required : Object.keys(spec?.required ?? {})),
      ...(Array.isArray(spec?.input_order?.optional) ? spec.input_order.optional : Object.keys(spec?.optional ?? {})),
    ]
    const widgets = Array.isArray(node.widgets_values) ? [...node.widgets_values] : []
    const inputs = {}
    const linkInputs = new Map()
    for (const input of node.inputs ?? []) {
      if (input?.link !== null && input?.link !== undefined && linkMap.has(String(input.link))) {
        linkInputs.set(String(input.name), linkMap.get(String(input.link)))
      }
    }
    // 画布会为 seed 额外插入 control_after_generate，而 object_info 的 schema 里没有它。
    // widgets_values 只存非连线输入，所以要按“去掉连线输入后的顺序”定位 seed，再跳过它的下一个值。
    const widgetOrder = order.filter((name) => !linkInputs.has(name))
    const seedIndex = widgetOrder.indexOf('seed')
    if (seedIndex >= 0 && !order.includes('control_after_generate')
      && seedIndex + 1 < widgets.length
      && SEED_CONTROL_VALUES.has(String(widgets[seedIndex + 1] ?? '').toLowerCase())) {
      widgets.splice(seedIndex + 1, 1)
      warnings.push(`节点 ${node.id}（${node.type}）已跳过画布专用的 control_after_generate`)
    }
    for (const name of order) {
      if (linkInputs.has(name)) {
        inputs[name] = linkInputs.get(name)
        continue
      }
      if (widgets.length > 0) inputs[name] = widgets.shift()
    }
    // 没有 object_info 时退化为“按 node.inputs 顺序 + widgets_values 顺序”尽力转换
    if (Object.keys(inputs).length === 0) {
      let index = 0
      for (const input of node.inputs ?? []) {
        if (linkInputs.has(String(input.name))) inputs[input.name] = linkInputs.get(String(input.name))
        else if (index < widgets.length) inputs[input.name] = widgets[index++]
      }
    }
    prompt[String(node.id)] = { class_type: String(node.type), inputs }
  }
  if (Object.keys(prompt).length === 0) throw new ComfyError('工作流里没有可提交的节点', { code: 'bad-workflow' })
  return { prompt, warnings }
}

/**
 * 清理后端无法执行的节点：画布专用节点（Note/Reroute/PrimitiveNode）以及
 * object_info 里查不到、明显未安装的自定义节点。返回新 prompt 和警告列表。
 * Reroute 会对下游做单输入直通重连，其它被移除节点的下游连线则断开。
 */
export function sanitizePrompt(prompt, objectInfo = {}) {
  if (!isObject(prompt)) return { prompt, warnings: [] }
  const warnings = []
  const skip = new Set()
  const hasInfo = isObject(objectInfo) && Object.keys(objectInfo).length > 0
  for (const [id, node] of Object.entries(prompt)) {
    const type = String(node?.class_type ?? '')
    if (UI_ONLY_TYPES.has(type)) {
      skip.add(id)
    } else if (hasInfo && !Object.prototype.hasOwnProperty.call(objectInfo, type)) {
      skip.add(id)
    }
  }
  if (skip.size === 0) return { prompt, warnings }

  const sources = new Map()
  const resolve = (id, seen = new Set()) => {
    if (sources.has(id)) return sources.get(id)
    if (seen.has(id)) return null
    seen.add(id)
    const node = prompt[id]
    for (const value of Object.values(node?.inputs ?? {})) {
      if (!isLink(value)) continue
      const upstream = String(value[0])
      const result = skip.has(upstream) ? resolve(upstream, seen) : value
      sources.set(id, result)
      return result
    }
    sources.set(id, null)
    return null
  }

  const next = {}
  for (const [id, node] of Object.entries(prompt)) {
    if (skip.has(id)) {
      warnings.push(`已跳过界面/不可用节点 ${id}（${String(node?.class_type ?? '')}）`)
      continue
    }
    const inputs = {}
    for (const [name, value] of Object.entries(node?.inputs ?? {})) {
      if (isLink(value) && skip.has(String(value[0]))) {
        const source = resolve(String(value[0]))
        if (source) inputs[name] = source
        else warnings.push(`节点 ${id}.${name} 的上游已被跳过，连线已断开`)
      } else {
        inputs[name] = value
      }
    }
    next[id] = { ...node, inputs }
  }
  return { prompt: next, warnings }
}

/** 找语义槽位：checkpoint / positive / negative / sampler / latent / loadImage / output。 */
export function findSlots(prompt) {
  const slots = {}
  let samplerNode = null
  for (const [id, node] of Object.entries(prompt)) {
    const type = String(node?.class_type ?? '')
    if (/CheckpointLoader|UNETLoader|diffusion_model/i.test(type)) slots.checkpoint ??= id
    if (type === 'KSampler' || type === 'KSamplerAdvanced' || /SamplerCustom/i.test(type)) samplerNode ??= id
    if (/EmptyLatentImage|EmptySD3LatentImage|EmptySDXL|LatentImage/i.test(type)) slots.latent ??= id
    if (/^LoadImage/.test(type)) slots.loadImage ??= id
    if (/^SaveImage|^PreviewImage|ImageSave/i.test(type)) slots.output ??= id
  }
  if (samplerNode !== null) {
    slots.sampler = samplerNode
    const sampler = prompt[samplerNode]
    const pos = sampler?.inputs?.positive
    const neg = sampler?.inputs?.negative
    if (isLink(pos)) slots.positive = pos[0]
    if (isLink(neg)) slots.negative = neg[0]
  }
  if (slots.positive === undefined || slots.negative === undefined) {
    const texts = Object.entries(prompt).filter(([, node]) => String(node?.class_type ?? '') === 'CLIPTextEncode')
    if (slots.positive === undefined && texts[0]) slots.positive = texts[0][0]
    if (slots.negative === undefined && texts[1]) slots.negative = texts[1][0]
  }
  return slots
}

/** prompt → 节点映射视图。 */
export function describeMapping(prompt, objectInfo = {}) {
  if (!isObject(prompt)) throw new ComfyError('工作流不是 API 格式（prompt 必须是对象）', { code: 'bad-prompt' })
  const consumers = new Map()
  for (const [id, node] of Object.entries(prompt)) {
    for (const [name, value] of Object.entries(node?.inputs ?? {})) {
      if (!isLink(value)) continue
      const key = String(value[0])
      if (!consumers.has(key)) consumers.set(key, [])
      consumers.get(key).push({ node: id, input: name, slot: value[1] })
    }
  }
  const nodes = Object.entries(prompt).map(([id, node]) => {
    const type = String(node?.class_type ?? '')
    const info = objectInfo?.[type] ?? {}
    const inputs = Object.entries(node?.inputs ?? {}).map(([name, value]) => ({
      name,
      value: isLink(value) ? null : value,
      source: isLink(value) ? { node: String(value[0]), slot: value[1] } : null,
      editable: !isLink(value),
    }))
    return {
      id,
      classType: type,
      title: String(info.display_name ?? type),
      category: String(info.category ?? ''),
      inputs,
      outputs: consumers.get(id) ?? [],
    }
  })
  const slots = findSlots(prompt)
  const editable = [
    { key: 'checkpoint', label: '模型 checkpoint', node: slots.checkpoint, input: 'ckpt_name' },
    { key: 'positive', label: '正向提示词', node: slots.positive, input: 'text' },
    { key: 'negative', label: '负向提示词', node: slots.negative, input: 'text' },
    { key: 'width', label: '宽度', node: slots.latent, input: 'width' },
    { key: 'height', label: '高度', node: slots.latent, input: 'height' },
    { key: 'batch', label: '批次数量', node: slots.latent, input: 'batch_size' },
    { key: 'steps', label: '采样步数', node: slots.sampler, input: 'steps' },
    { key: 'cfg', label: 'CFG', node: slots.sampler, input: 'cfg' },
    { key: 'seed', label: '随机种子', node: slots.sampler, input: 'seed' },
    { key: 'sampler_name', label: '采样器', node: slots.sampler, input: 'sampler_name' },
    { key: 'scheduler', label: '调度器', node: slots.sampler, input: 'scheduler' },
    { key: 'denoise', label: '重绘幅度', node: slots.sampler, input: 'denoise' },
    { key: 'image', label: '输入图片', node: slots.loadImage, input: 'image' },
    { key: 'filenamePrefix', label: '文件名前缀', node: slots.output, input: 'filename_prefix' },
  ].filter((item) => typeof item.node === 'string' && item.node !== '' && prompt[item.node]?.inputs && item.input in prompt[item.node].inputs)
  return { nodes, slots, editable }
}

/** 从 prompt 里抽出当前参数，回灌到面板。 */
export function extractParams(prompt) {
  const slots = findSlots(prompt)
  const read = (nodeId, input, fallback) => {
    const value = nodeId ? prompt?.[nodeId]?.inputs?.[input] : undefined
    if (value === undefined || isLink(value)) return fallback
    return value
  }
  return {
    checkpoint: read(slots.checkpoint, 'ckpt_name', ''),
    positive: String(read(slots.positive, 'text', '')),
    negative: String(read(slots.negative, 'text', '')),
    width: read(slots.latent, 'width', 1024),
    height: read(slots.latent, 'height', 1024),
    batch: read(slots.latent, 'batch_size', 1),
    steps: read(slots.sampler, 'steps', 28),
    cfg: read(slots.sampler, 'cfg', 7),
    seed: read(slots.sampler, 'seed', -1),
    sampler_name: read(slots.sampler, 'sampler_name', ''),
    scheduler: read(slots.sampler, 'scheduler', ''),
    denoise: read(slots.sampler, 'denoise', 1),
    filenamePrefix: read(slots.output, 'filename_prefix', 'DSHDesk'),
  }
}

/** 把面板参数与显式 overrides 写回 prompt。 */
export function applyOverrides(prompt, params = {}, overrides = {}) {
  const next = structuredClone(prompt)
  const applied = []
  const warnings = []
  const slots = findSlots(next)
  const set = (nodeId, input, value, label) => {
    if (typeof nodeId !== 'string' || nodeId === '' || !next[nodeId]?.inputs || !(input in next[nodeId].inputs)) return
    next[nodeId].inputs[input] = value
    applied.push(`${label || input} → 节点 ${nodeId}.${input}`)
  }
  if (params.checkpoint) set(slots.checkpoint, 'ckpt_name', String(params.checkpoint), '模型')
  if (params.positive !== undefined && params.positive !== null) set(slots.positive, 'text', String(params.positive), '正向提示词')
  if (params.negative !== undefined && params.negative !== null) set(slots.negative, 'text', String(params.negative), '负向提示词')
  if (params.width !== undefined) set(slots.latent, 'width', clampInt(params.width, 64, 4096, 1024), '宽度')
  if (params.height !== undefined) set(slots.latent, 'height', clampInt(params.height, 64, 4096, 1024), '高度')
  if (params.batch !== undefined) set(slots.latent, 'batch_size', clampInt(params.batch, 1, 16, 1), '批次')
  for (const key of ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']) {
    if (params[key] !== undefined && params[key] !== '') {
      const value = key === 'steps' ? clampInt(params[key], 1, 1000, 28)
        : key === 'cfg' ? clampNumber(params[key], 0, 100, 7)
          : key === 'denoise' ? clampNumber(params[key], 0, 1, 1)
            : String(params[key])
      set(slots.sampler, key, value, key)
    }
  }
  if (params.seed !== undefined && params.seed !== null && String(params.seed) !== '') {
    set(slots.sampler, 'seed', randomSeed(params.seed), '种子')
  }
  if (params.image) set(slots.loadImage, 'image', String(params.image), '输入图片')
  if (params.filenamePrefix) set(slots.output, 'filename_prefix', safeFilename(params.filenamePrefix, 'DSHDesk'), '文件名前缀')
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const dot = String(key).lastIndexOf('.')
    if (dot < 1) {
      warnings.push(`忽略无法识别的 override：${key}`)
      continue
    }
    const nodeId = String(key).slice(0, dot)
    const input = String(key).slice(dot + 1)
    if (!next[nodeId]?.inputs || !(input in next[nodeId].inputs)) {
      warnings.push(`节点 ${nodeId} 没有输入 ${input}，已忽略`)
      continue
    }
    next[nodeId].inputs[input] = value
    applied.push(`手动映射 ${nodeId}.${input}`)
  }
  return { prompt: next, applied, warnings }
}

/**
 * 从 UI 画布文档提取可绘制的图：节点（id/type/title/pos/size/mode/端口/控件值）
 * 和连线（from/to 节点与端口）。供前端画出真正的节点图；API 格式没有画布则返回空。
 */
export function extractCanvas(document, objectInfo = {}) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const links = Array.isArray(document?.links) ? document.links : []
  const groups = Array.isArray(document?.groups) ? document.groups : []
  const canvasNodes = nodes.filter(isObject).map((node) => {
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
    const inputs = Array.isArray(node.inputs) ? node.inputs : []
    const outputs = Array.isArray(node.outputs) ? node.outputs : []
    return {
      id: String(node.id ?? ''),
      type: String(node.type ?? ''),
      title: typeof node.title === 'string' && node.title !== '' ? node.title : String(node.type ?? node.id ?? ''),
      category: String(objectInfo?.[node.type]?.category ?? ''),
      pos: Array.isArray(node.pos) ? node.pos.map((value) => Number(value) || 0) : [0, 0],
      size: Array.isArray(node.size) ? node.size.map((value) => Number(value) || 0) : [0, 0],
      mode: Number(node.mode ?? 0),
      inputs: inputs.map((input, index) => ({
        name: String(input?.name ?? input?.localized_name ?? `#${index}`),
        link: input?.link === null || input?.link === undefined ? null : Number(input.link),
      })),
      outputs: outputs.map((output, index) => ({
        name: String(output?.name ?? output?.localized_name ?? `#${index}`),
        links: Array.isArray(output?.links) ? output.links.map((value) => Number(value)) : [],
      })),
      widgets: widgets.map((value, index) => ({ name: `控件 ${index + 1}`, value })),
    }
  })
  const canvasLinks = links.filter(Array.isArray).map((link) => ({
    id: Number(link[0]),
    from: String(link[1] ?? ''),
    fromSlot: Number(link[2] ?? 0),
    to: String(link[3] ?? ''),
    toSlot: Number(link[4] ?? 0),
    type: String(link[5] ?? ''),
  }))
  const canvasGroups = groups.filter(isObject).map((group) => ({
    title: String(group.title ?? ''),
    pos: Array.isArray(group.pos) ? group.pos.map((value) => Number(value) || 0) : [0, 0],
    size: Array.isArray(group.size) ? group.size.map((value) => Number(value) || 0) : [0, 0],
    color: typeof group.color === 'string' ? group.color : '',
  }))
  return { nodes: canvasNodes, links: canvasLinks, groups: canvasGroups }
}

/** 兼容两种输入：API prompt 或 UI 画布图。 */
export function parseWorkflowDocument(document, objectInfo = {}) {
  if (!isObject(document)) throw new ComfyError('工作流 JSON 必须是对象', { code: 'bad-workflow' })
  let prompt
  let warnings = []
  if (isObject(document.prompt) && !Array.isArray(document.nodes)) {
    prompt = document.prompt
  } else if (Array.isArray(document.nodes)) {
    const converted = uiToPrompt(document, objectInfo)
    prompt = converted.prompt
    warnings = converted.warnings
  } else if (Object.values(document).every((node) => isObject(node) && typeof node.class_type === 'string')) {
    prompt = document
  } else {
    throw new ComfyError('无法识别的工作流格式（需要 nodes/links 或 class_type 节点）', { code: 'bad-workflow' })
  }
  const cleaned = sanitizePrompt(prompt, objectInfo)
  prompt = cleaned.prompt
  warnings = [...warnings, ...cleaned.warnings]
  const mapping = describeMapping(prompt, objectInfo)
  const canvas = extractCanvas(document, objectInfo)
  return { prompt, mapping, canvas, warnings, params: extractParams(prompt) }
}
