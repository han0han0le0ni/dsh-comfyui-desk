/** DSH LLM 服务封装：列出模型库、用选中的模型写 ComfyUI 提示词。
 *  只通过 ctx.get('llm') 访问宿主服务，不 import 任何 @deepseek-ai/* 包。 */

class LlmError extends Error {
  constructor(message, status = 503) {
    super(message)
    this.status = status
  }
}

export function getLlm(ctx) {
  let service
  try {
    service = typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm
  } catch {
    service = ctx?.llm
  }
  if (!service) throw new LlmError('当前 DSH 会话没有可用的 llm 服务', 503)
  return service
}

/** 当前默认选择的 { provider, model }。优先 agentDefaultModel，其次 llm 服务自身。 */
export function defaultSelection(ctx, service = getLlm(ctx)) {
  // agentDefaultModel.currentSelection() 是 DSH 文档里的默认模型来源
  for (const name of ['agentDefaultModel', 'defaultModel']) {
    try {
      const provider = typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]
      if (provider && typeof provider.currentSelection === 'function') {
        const selection = provider.currentSelection()
        if (selection?.provider && selection?.model) {
          return { provider: String(selection.provider), model: String(selection.model) }
        }
      }
    } catch { /* ignore */ }
  }
  // 兜底：从 llm 服务读已配置选择（不同版本方法名不同）
  for (const method of ['currentSelection', 'getSelection', 'defaultRoute']) {
    try {
      if (typeof service[method] === 'function') {
        const selection = service[method]()
        if (selection?.provider && selection?.model) {
          return { provider: String(selection.provider), model: String(selection.model) }
        }
      }
    } catch { /* ignore */ }
  }
  return { provider: '', model: '' }
}

/** 列出 DSH 模型库：按 provider 分组，附默认选择。失败时返回空列表和错误说明，不抛出。 */
export async function listChatModels(ctx) {
  const service = getLlm(ctx)
  const fallback = defaultSelection(ctx, service)
  const groups = []
  let warning = ''
  const listProviders = typeof service.listProviders === 'function' ? service.listProviders() : []
  for (const provider of listProviders ?? []) {
    const id = typeof provider === 'string' ? provider : provider?.id
    if (!id) continue
    const name = (typeof provider === 'object' && provider.name) || id
    let models = []
    try {
      models = (await service.listModels(id)) ?? []
    } catch (error) {
      warning = warning || `部分 provider（${id}）模型读取失败：${error?.message ?? String(error)}`
    }
    groups.push({
      provider: String(id),
      name: String(name),
      models: models.map((model) => {
        const modelId = typeof model === 'string' ? model : model?.id
        return {
          id: String(modelId ?? ''),
          name: String((typeof model === 'object' && (model.name || model.displayName)) || modelId || ''),
        }
      }).filter((model) => model.id !== ''),
    })
  }
  if (groups.length === 0 && !warning) warning = 'DSH 模型库返回空列表，请先在 DSH 设置里配置模型 provider。'
  return { groups, default: fallback, warning }
}

/** 生成写提示词的系统提示。 */
const SYSTEM_PROMPT = [
  '你是 Stable Diffusion / Flux 提示词工程师。根据用户中文想法、当前正向与负向提示词、所用 checkpoint，',
  '输出一段可直接用于出图的英文提示词。要求：具体、视觉化、包含主体/外观/环境/光线/镜头/风格；',
  '如果是标签类模型（NoobAI/Illustrious/Pony/Anima）用逗号分隔的 danbooru 标签；',
  '如果是 Flux/SD3/Qwen 用自然英文描述。不要解释，不要 Markdown，只输出提示词正文。',
].join('')

function buildMessages(args) {
  const lines = [`用户想法：${String(args?.idea ?? '')}`]
  if (args?.positive) lines.push(`现有正向提示词：${String(args.positive)}`)
  if (args?.negative) lines.push(`现有负向提示词：${String(args.negative)}`)
  if (args?.checkpoint) lines.push(`当前模型：${String(args.checkpoint)}`)
  return [{ role: 'user', content: [{ type: 'text', text: lines.join('\n') }] }]
}

/** 用 DSH 会话模型（或显式指定）写提示词。
 *  provider/model 均省略时，回退到 DSH 默认选择；仍拿不到才报错。 */
export async function writePromptWith(ctx, args = {}, options = {}) {
  const service = getLlm(ctx)
  if (typeof service.stream !== 'function') throw new LlmError('llm 服务不支持 stream()', 503)
  const fallback = defaultSelection(ctx, service)
  const provider = String(args.provider ?? options.configProvider ?? fallback.provider ?? '').trim()
  const model = String(args.model ?? options.configModel ?? fallback.model ?? '').trim()
  if (!provider || !model) {
    throw new LlmError('没解析到模型，请先在 DSH 设置里配置模型，或在面板里选择一个模型', 400)
  }
  let text = ''
  const request = {
    provider,
    model,
    system: SYSTEM_PROMPT,
    messages: buildMessages(args),
    signal: options.signal ?? AbortSignal.timeout(60_000),
  }
  for await (const chunk of service.stream(request)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  if (text.trim() === '') throw new LlmError('AI 没有返回提示词内容', 502)
  return text.trim()
}
