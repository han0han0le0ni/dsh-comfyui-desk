/** 给 DSH Agent 用的工具：在对话里也能查状态、出图、取图和写提示词。 */

import { ComfyError, collectImages, history, historyOne, normalizeBase, objectInfo, probe, progressOf, queueState, submitPrompt, viewFile } from './comfy.js'
import { applyOverrides, buildTxt2Img, parseWorkflowDocument, sanitizePrompt } from './graph.js'
import { listWorkflows, readWorkflow, classifyWorkflow, pickWorkflow } from './workflows.js'
import { listImages, resolveLibraryDir } from './store.js'
import { writePromptWith } from './llm.js'

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const int = (description) => ({ type: 'integer', description })
const obj = (description) => ({ type: 'object', additionalProperties: true, description })

function params(properties, required = []) {
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function outputSchema() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const parts = [{ type: 'text', text: String(value?.text ?? '') }]
      for (const ref of Array.isArray(value?.images) ? value.images : []) {
        if (ref && typeof ref === 'object' && typeof ref.attachmentId === 'string') {
          parts.push({ type: 'image', attachment: ref })
        }
      }
      return parts
    },
  }
}

/** 按文件头判断图片类型，识别不了再退回响应头 */
function sniffMediaType(buffer, contentType) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp'
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (typeof contentType === 'string' && contentType.startsWith('image/')) return contentType.split(';')[0]
  return null
}

function explain(error) {
  if (error instanceof ComfyError) return error.message
  return error?.message ?? String(error)
}

function currentRoute(exec) {
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  return {
    provider: routed?.provider ?? exec?.agent?.options?.provider,
    model: routed?.model ?? exec?.agent?.options?.model,
  }
}

/** 从用户描述里猜工作流用途，用于 AI 未指定工作流时自选。 */
function detectPurpose(text) {
  const value = String(text ?? '')
  if (/视频|动画|动态|video|会动/i.test(value)) return '视频'
  if (/放大|超分|高清化|放大图|4k|8k|upscale/i.test(value)) return '高清放大'
  if (/局部重绘|局部修改|涂抹|重绘某|改某处|换脸|inpaint/i.test(value)) return '局部重绘'
  if (/根据这张|参考这张|把这张|基于图片|图生图|转成|改成|img2img/i.test(value)) return '图生图'
  if (/动作|姿态|姿势|pose|复刻动作|迁移动作/i.test(value)) return '动作姿态'
  return '文生图'
}

function hasChinese(text) {
  return /[\u4e00-\u9fa5]/.test(String(text ?? ''))
}

/**
 * 解析本次生成要用的工作流：用户/AI 显式指定优先；否则按意图自动挑一个合适的已保存工作流。
 * 自动挑选只选不需要源图的（需要源图的工作流缺少输入会失败），挑不到时返回 null 让调用方回退内置模板。
 */
async function resolveWorkflow(base, config, args) {
  const requested = String(args.workflowName ?? '').trim()
  if (requested) {
    const saved = await readWorkflow(base, { dirs: config.workflowDirs }, requested)
    const info = classifyWorkflow({ name: saved.name, types: [] })
    const notes = [`使用工作流：${saved.name}`]
    if (info.needsSource) notes.push('注意：该工作流需要源图，请提供图片路径，否则生成可能失败')
    return { saved, notes, auto: false }
  }

  // 自动挑选：合并用户提示词 + 负向提示词作为意图来源。
  const intent = [args.positive, args.negative].filter(Boolean).join(' ')
  const purpose = detectPurpose(intent)
  const scanned = await listWorkflows(base, { dirs: config.workflowDirs })
  if (!scanned.items.length) return null
  const picked = pickWorkflow(scanned.items, {
    purpose,
    chinese: hasChinese(args.positive),
    requireNoSource: true,
  })
  if (!picked) {
    // 有这类工作流但都需要源图（放大/重绘/图生图/视频常见），给出可操作提示而非静默回退。
    const needsInput = pickWorkflow(scanned.items, { purpose })
    if (needsInput) {
      return {
        saved: null,
        warnings: [`识别到「${purpose}」意图，但本机工作流「${needsInput.name}」需要源图。请在 ComfyUI 侧边栏面板载入它并指定图片后再生成，或用 workflowName 明确指定一个文生图工作流。`],
        auto: false,
      }
    }
    return null
  }
  const saved = await readWorkflow(base, { dirs: config.workflowDirs }, picked.name)
  return {
    saved,
    notes: [`AI 自选工作流：${saved.name}（${picked.reason}）`],
    auto: true,
  }
}

async function llmWrite(ctx, config, exec, args) {
  // currentRoute() 拿到当前 agent 会话实际使用的 provider/model，作为默认值传给统一封装。
  const route = currentRoute(exec)
  return writePromptWith(ctx, {
    ...args,
    provider: String(args.provider || route.provider || ''),
    model: String(args.model || route.model || ''),
  }, {
    configProvider: config.llmProvider,
    configModel: config.llmModel,
    signal: exec?.signal,
  })
}

export function registerTools(ctx, config = {}) {
  const cfg = config ?? {}
  const base = normalizeBase(cfg.baseUrl ?? 'http://127.0.0.1:8188')
  const disposers = []
  const register = (definition) => {
    const result = ctx.tools.register(definition)
    if (typeof result === 'function') disposers.push(result)
  }

  /** 取回输出图并登记成附件，让 DSH 对话直接显示；任何一步失败都返回空数组，不影响生图结果 */
  async function collectImageRefs(images) {
    const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : null
    if (!attachments || typeof attachments.saveImage !== 'function') return []
    const limits = attachments.imageLimits ?? {}
    const maxBytes = Math.min(
      Number(limits.maxImageBytes ?? Number.POSITIVE_INFINITY),
      Number(limits.maxMessageImageBytes ?? Number.POSITIVE_INFINITY),
    )
    const refs = []
    for (const image of images) {
      try {
        const file = await viewFile(base, image, { timeout: Number(cfg.requestTimeoutMs ?? 10_000) })
        if (Number.isFinite(maxBytes) && file.buffer.length > maxBytes) continue
        const mediaType = sniffMediaType(file.buffer, file.contentType)
        if (!mediaType) continue
        refs.push(await attachments.saveImage({ data: file.buffer, mediaType, name: image.filename }))
      } catch {
        // 单张失败就跳过，生成本身已经成功
      }
    }
    return refs
  }

  register({
    name: 'comfy_desk_status',
    description: '查看本机 ComfyUI 的连接状态、版本、GPU/显存、内存和队列。用户问“ComfyUI 在线吗 / 显卡状态 / 队列多少”时用。',
    parameters: params({}),
    output: outputSchema(),
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const data = await probe(base, { timeout: Number(cfg.requestTimeoutMs ?? 10_000) })
        const devices = data.devices.map((device) => {
          const total = Number(device.vram_total ?? 0)
          const free = Number(device.vram_free ?? 0)
          return `${device.name ?? device.type ?? 'GPU'} 显存 ${(free / 1073741824).toFixed(1)}/${(total / 1073741824).toFixed(1)} GB`
        }).join('；') || '未报告显卡'
        return {
          text: [
            `ComfyUI ${data.version || '未知版本'}：在线`,
            `显卡：${devices}`,
            `内存：${(data.ramFree / 1073741824).toFixed(1)}/${(data.ramTotal / 1073741824).toFixed(1)} GB 可用`,
            `队列：运行中 ${data.queueRunning}，等待 ${data.queuePending}`,
          ].join('\n'),
        }
      } catch (error) {
        return { text: `ComfyUI 连接失败：${explain(error)}` }
      }
    },
  })

  register({
    name: 'comfy_desk_generate',
    description: '在本机 ComfyUI 提交一次生成任务（只提交，不等待完成）。用户说“帮我在 ComfyUI 里生成一张图 / 用某某工作流出图”时用；如果用户想立刻在对话里看到图片，请改用 comfy_desk_draw。工作流未指定时会按画面描述自动挑选本机已保存的合适工作流，挑不到才用内置模板；用户点名时才用 workflowName 指定。',
    parameters: params({
      positive: str('正向提示词'),
      negative: str('负向提示词，可选'),
      checkpoint: str('checkpoint 文件名，可选，省略则用第一个可用模型'),
      width: int('宽度，默认 1024'),
      height: int('高度，默认 1024'),
      steps: int('采样步数，默认 28'),
      cfg: num('CFG，默认 7'),
      seed: int('种子，省略或负数表示随机'),
      batch: int('批次数量，默认 1'),
      workflow: str('工作流 JSON 字符串，可选。不给则用内置文生图模板'),
      workflowName: str('已保存工作流的名字，可选。用户点名时才填；留空则按画面描述自动挑选'),
      overrides: obj('节点覆盖，键为 "<节点id>.<输入名>"，例如 {"5.steps": 30}'),
    }),
    output: outputSchema(),
    async execute(args) {
      try {
        const info = await objectInfo(base).catch(() => ({}))
        let prompt
        let warnings = []
        if (typeof args.workflow === 'string' && args.workflow.trim() !== '') {
          const parsed = parseWorkflowDocument(JSON.parse(args.workflow), info)
          prompt = parsed.prompt
          warnings = parsed.warnings
        } else {
          const chosen = await resolveWorkflow(base, cfg, args).catch(() => null)
          if (chosen && chosen.saved) {
            const parsed = parseWorkflowDocument(chosen.saved.document, info)
            prompt = parsed.prompt
            warnings = [...chosen.notes, ...parsed.warnings]
          } else if (chosen && chosen.warnings) {
            return { text: ['生成需要额外信息：', ...chosen.warnings].join('\n') }
          } else {
            prompt = buildTxt2Img(info, args)
          }
        }
        const cleaned = sanitizePrompt(prompt, info)
        warnings.push(...cleaned.warnings)
        const applied = applyOverrides(cleaned.prompt, args, args.overrides ?? {})
        const submitted = await submitPrompt(base, applied.prompt, `dsh-desk-tool-${process.pid}`)
        return {
          text: [
            `已提交到 ComfyUI，prompt_id=${submitted?.prompt_id ?? ''}`,
            `队列编号：${submitted?.number ?? '未知'}`,
            ...applied.applied.slice(0, 20).map((line) => `· ${line}`),
            ...warnings,
            '可用 comfy_desk_progress 查询进度，comfy_desk_history 取回图片。',
          ].join('\n'),
        }
      } catch (error) {
        return { text: `提交失败：${explain(error)}` }
      }
    },
  })

  register({
    name: 'comfy_desk_draw',
    description: '用本机 ComfyUI 画图，并把生成的图片直接显示在 DSH 对话里。只要用户想要看到一张图——例如“画一只猫 / 给我画张图 / 生成一张看看 / 用某某工作流出张图 / 先画一张我看看”——就用这个工具，不用先问工具名，也不要只调用 comfy_desk_generate（那个只提交不返回图片）。会等待生成完成（最多约 90 秒）。**工作流会自动选**：用户没指定时，工具会根据画面描述从本机已保存工作流里挑一个最合适的（中文描述优先中文工作流；提到视频/放大/重绘/动作会选对应工作流；挑不到才用内置模板），不需要你手动去查列表。只有用户明确点名某个工作流时，才通过 workflowName 指定。',
    parameters: params({
      positive: str('画面描述 / 正向提示词，必填'),
      negative: str('负向提示词，可选'),
      workflowName: str('已保存工作流名字，可选。用户明确点名时才填（可用 comfy_desk_workflows 查到）；留空则 AI 自动挑选，无需手动指定'),
      width: int('宽度，默认 1024'),
      height: int('高度，默认 1024'),
      steps: int('采样步数，默认 28'),
      cfg: num('CFG，默认 7'),
      seed: int('种子，省略则随机'),
      batch: int('一次画几张，默认 1'),
    }, ['positive']),
    output: outputSchema(),
    async execute(args, exec) {
      try {
        const info = await objectInfo(base).catch(() => ({}))
        let prompt
        const warnings = []
        const chosen = await resolveWorkflow(base, cfg, args).catch(() => null)
        if (chosen && chosen.saved) {
          const parsed = parseWorkflowDocument(chosen.saved.document, info)
          prompt = parsed.prompt
          warnings.push(...chosen.notes, ...parsed.warnings)
        } else if (chosen && chosen.warnings) {
          // 识别到需源图的意图：不静默画图，把提示作为结果返回让用户知道该怎么做。
          return { text: ['画图需要额外信息：', ...chosen.warnings].join('\n') }
        } else {
          prompt = buildTxt2Img(info, args)
          warnings.push('未找到合适的已保存工作流，使用内置文生图模板')
        }
        const cleaned = sanitizePrompt(prompt, info)
        warnings.push(...cleaned.warnings)
        const applied = applyOverrides(cleaned.prompt, args, {})
        const submitted = await submitPrompt(base, applied.prompt, `dsh-desk-draw-${process.pid}`)
        const promptId = String(submitted?.prompt_id ?? '')
        const deadline = Date.now() + 90_000
        let state = null
        let record = null
        while (Date.now() < deadline) {
          if (exec?.signal?.aborted) throw new Error('画图已取消')
          await new Promise((resolve) => setTimeout(resolve, 2000))
          record = await historyOne(base, promptId).catch(() => null)
          state = progressOf(record?.[promptId] ?? record)
          if (state.completed || state.failed) break
        }
        const images = collectImages(record?.[promptId] ?? record)
        const lines = [
          `prompt_id: ${promptId}`,
          ...warnings,
          state?.failed ? '生成失败' : state?.completed ? '生成完成' : '仍在生成中，可用 comfy_desk_progress 查看',
        ]
        const shown = images.slice(0, 4)
        const refs = await collectImageRefs(shown)
        if (refs.length > 0) {
          lines.push(`已在对话里附上 ${refs.length} 张图：${shown.slice(0, refs.length).map((image) => image.filename).join(', ')}`)
        }
        for (const image of images) {
          // 同时给出 ComfyUI 绝对地址的 markdown 图片：DSH 能渲染外链图时就直接看到大图，不能也只是多一行文字。
          const url = base + '/view?filename=' + encodeURIComponent(image.filename)
            + '&subfolder=' + encodeURIComponent(image.subfolder ?? '')
            + '&type=' + encodeURIComponent(image.type ?? 'output')
          lines.push(`![${image.filename}](${url})`)
        }
        if (images.length === 0 && state?.completed) lines.push('任务已完成但没取到图片，可用 comfy_desk_history 查看输出文件名。')
        return { text: lines.join('\n'), images: refs }
      } catch (error) {
        return { text: `画图失败：${explain(error)}` }
      }
    },
  })

  register({
    name: 'comfy_desk_progress',
    description: '查询某个 ComfyUI 生成任务的进度、是否完成、输出图片文件名。',
    parameters: params({ promptId: str('comfy_desk_generate 返回的 prompt_id') }, ['promptId']),
    output: outputSchema(),
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const mod = await import('./comfy.js')
        const [record, queue] = await Promise.all([
          mod.historyOne(base, String(args.promptId ?? '')),
          mod.queueState(base).catch(() => ({ queue_running: [], queue_pending: [] })),
        ])
        const data = record?.[args.promptId] ?? record
        const state = progressOf(data)
        const images = collectImages(data)
        return {
          text: [
            `任务 ${args.promptId}：${state.failed ? '失败' : state.completed ? '已完成' : `生成中 ${state.percent}%`}`,
            state.node ? `当前节点：${state.node}` : '',
            images.length ? `输出图片：${images.map((image) => image.filename).join(', ')}` : '',
            `等待队列：${(queue?.queue_pending ?? []).length}`,
          ].filter(Boolean).join('\n'),
        }
      } catch (error) {
        return { text: `查询失败：${explain(error)}` }
      }
    },
  })

  register({
    name: 'comfy_desk_history',
    description: '列出 ComfyUI 最近生成记录和图片文件名。',
    parameters: params({ limit: int('条数，默认 10，最大 50') }),
    output: outputSchema(),
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50)
        const records = await history(base, limit)
        const lines = records.map((record) => {
          const state = progressOf(record)
          const images = collectImages(record).map((image) => image.filename)
          return `#${record?.prompt?.[0] ?? '?'} ${record.id.slice(0, 8)} ${state.failed ? '失败' : state.completed ? '完成' : '进行中'} ${images.join(', ')}`
        })
        return { text: lines.length ? lines.join('\n') : '最近没有生成记录' }
      } catch (error) {
        return { text: `读取历史失败：${explain(error)}` }
      }
    },
  })

  register({
    name: 'comfy_desk_images',
    description: '列出 DSH ComfyUI 插件保存在本地图片库里的图片（路径、文件名、大小、时间）。',
    parameters: params({ limit: int('条数，默认 30') }),
    output: outputSchema(),
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const images = await listImages(cfg, Number(args.limit ?? 30))
        const lines = images.map((image) => `${image.name} (${(image.size / 1024).toFixed(0)} KB)`)
        return { text: `图片库：${resolveLibraryDir(cfg)}\n${lines.join('\n') || '（空）'}` }
      } catch (error) {
        return { text: `读取图片库失败：${explain(error)}` }
      }
    },
  })

  register({
    name: 'comfy_desk_prompt',
    description: '让 AI 根据用户的中文想法写一段可直接用于 ComfyUI 的英文提示词。用户说“帮我写提示词 / 扩写提示词 / 改成标签”时用。',
    parameters: params({
      idea: str('用户的中文想法，必填'),
      positive: str('现有正向提示词，可选'),
      negative: str('现有负向提示词，可选'),
      checkpoint: str('当前模型 checkpoint，可选'),
      provider: str('模型 provider，可选，省略则用当前会话'),
      model: str('模型 id，可选，省略则用当前会话'),
    }, ['idea']),
    output: outputSchema(),
    async execute(args, exec) {
      try {
        return { text: await llmWrite(ctx, cfg, exec, args) }
      } catch (error) {
        return { text: `AI 写提示词失败：${explain(error)}` }
      }
    },
  })

  register({
    name: 'comfy_desk_workflows',
    description: '列出本机 ComfyUI 已保存的工作流（自动扫描磁盘，不需要 ComfyUI 开放 userdata 接口），每条都标注用途（文生图/图生图/局部重绘/高清放大/视频/动作姿态）、模型和是否需要源图。用户问“有哪些工作流 / 找一下某某工作流”时用；一般画图不需要先调它，comfy_desk_draw 会自动挑选。',
    parameters: params({}),
    output: outputSchema(),
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const result = await listWorkflows(base, { dirs: cfg.workflowDirs })
        const lines = result.items.map((item) => {
          const info = classifyWorkflow(item)
          return `· ${item.name} [${info.label}]（${item.nodeCount} 个节点：${item.types.slice(0, 3).join('、') || '未知'}）`
        })
        return {
          text: [
            `找到 ${result.items.length} 个工作流（来源：${result.source === 'disk' ? '本机磁盘' : 'ComfyUI 接口'}）：`,
            ...lines.slice(0, 60),
            ...(lines.length > 60 ? [`……还有 ${lines.length - 60} 个`] : []),
            result.warning,
          ].filter(Boolean).join('\n'),
        }
      } catch (error) {
        return { text: `扫描工作流失败：${explain(error)}` }
      }
    },
  })

  register({
    name: 'comfy_desk_workflow_map',
    description: '读取并分析一份 ComfyUI 工作流，列出节点映射、连线来源和可修改参数。可直接给已保存工作流的名字（推荐），也可给工作流 JSON 字符串。用户说“看看这个工作流有哪些节点 / 哪里改提示词”时用。',
    parameters: params({
      name: str('已保存工作流的名字，可选。可用 comfy_desk_workflows 查到'),
      workflow: str('工作流 JSON 字符串，可选。name 优先'),
    }),
    output: outputSchema(),
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const info = await objectInfo(base).catch(() => ({}))
        const document = String(args.name ?? '').trim()
          ? (await readWorkflow(base, { dirs: cfg.workflowDirs }, args.name)).document
          : JSON.parse(String(args.workflow ?? ''))
        const parsed = parseWorkflowDocument(document, info)
        const lines = parsed.mapping.nodes.map((node) => {
          const inputs = node.inputs.map((input) => {
            const value = input.source ? `← 节点 ${input.source.node}[${input.source.slot}]` : JSON.stringify(input.value)
            return `    ${input.name}: ${value}`
          }).join('\n')
          return `节点 ${node.id} · ${node.title} (${node.classType})\n${inputs}`
        })
        const editable = parsed.mapping.editable.map((item) => `  ${item.label}: ${item.node}.${item.input}`).join('\n')
        return { text: [`共 ${parsed.mapping.nodes.length} 个节点：`, ...lines, '可修改参数：', editable || '（无）'].join('\n') }
      } catch (error) {
        return { text: `分析工作流失败：${explain(error)}` }
      }
    },
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}
