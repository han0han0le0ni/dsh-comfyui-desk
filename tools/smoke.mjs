/** 无 DSH 也能跑的自检：语法、图转换、参数覆盖、映射、客户端产物。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { buildTxt2Img, parseWorkflowDocument, describeMapping, applyOverrides, sanitizePrompt, extractCanvas } from '../lib/graph.js'
import { progressOf, normalizeBase, collectImages, cpuUsagePercent } from '../lib/comfy.js'
import { makeRoutes } from '../lib/routes.js'
import { listWorkflows, readWorkflow, classifyWorkflow, pickWorkflow } from '../lib/workflows.js'
import { registerTools } from '../lib/tools.js'
import { applyCanvasEdit } from '../lib/workflow-edit.js'
import { writeWorkflow, workflowRevision } from '../lib/workflows.js'
import { listChatModels, writePromptWith, defaultSelection } from '../lib/llm.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

for (const file of ['../index.js', '../lib/comfy.js', '../lib/graph.js', '../lib/routes.js', '../lib/store.js', '../lib/tools.js', '../lib/llm.js']) {
  await import(file)
  console.log('加载 OK:', file)
}
new vm.Script(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'), { filename: 'client.js' })
console.log('语法 OK: client.js')

// 回归防护：所有 call('/xxx') 必须经 withPluginPrefix 补全为 /api/dsh-comfyui-desk/xxx，
// 否则 fetch('/status') 会命中 DSH 的 404，面板显示"连不上 DSH Host: HTTP 404"。
{
  const source = fs.readFileSync(path.join(ROOT, 'client.body.js'), 'utf8')
  const match = source.match(/function withPluginPrefix\(path\) \{([\s\S]*?)\n\}/)
  assert.ok(match, 'client.body.js 必须定义 withPluginPrefix')
  const withPluginPrefix = new Function('path', match[1])
  assert.ok(/withBase\(withPluginPrefix\(path\)/.test(source), 'api() 必须用 withPluginPrefix 包裹 path')
  assert.ok(/h\('label', null, '工作流'\)/.test(source), '生成页必须把「模型」下拉换成「工作流」下拉')
  assert.ok(/savedWorkflows\.map\(\(item\) => h\('option'/.test(source), '生成页工作流下拉必须列出已保存工作流')
  assert.ok(!/h\('label', null, '模型'\),\s*\n\s*h\('select'/.test(source), '生成页不应再有模型下拉')
  // 工作流画布 + 选择记忆回归
  assert.ok(/function WorkflowCanvas\(/.test(source), '必须定义 WorkflowCanvas 画布组件')
  assert.ok(/ccBezier\(/.test(source), '画布连线必须用贝塞尔曲线')
  assert.ok(/h\(WorkflowCanvas, \{/.test(source), '工作流页必须渲染 WorkflowCanvas')
  assert.ok(/addEventListener\('wheel'/.test(source), '画布必须支持滚轮缩放')
  assert.ok(/mode: 'node'/.test(source), '画布必须支持拖动节点')
  assert.ok(/mode: 'box'/.test(source), '画布必须支持框选多选')
  assert.ok(/h\('input', \{\s*key, className: 'ccd-cwidget-input'/.test(source), '节点控件必须可在画布内直接编辑')
  assert.ok(/call\('\/workflow-apply'/.test(source), '画布改动必须写回工作流文件')
  assert.ok(/call\('\/bridge-status'/.test(source), '必须探测 ComfyUI 桥接是否安装')
  assert.ok(/syncCanvas/.test(source), '必须有画布同步开关并持久化')
  assert.ok(/call\('\/workflow-revision\?name='/.test(source), '必须轮询 ComfyUI 保存的工作流变更')
  assert.ok(/selectedWorkflow: name/.test(source), '选择工作流必须写入 settings 持久化')
  assert.ok(/selectedWorkflow: '', \/\/ 上次选择的工作流名/.test(source), 'DEFAULT_SETTINGS 必须有 selectedWorkflow')
  assert.ok(/onWorkflowSelect\(remembered\)/.test(source), '重开面板必须自动恢复上次选择')
  // 回归：切换工作流不能覆盖用户输入的提示词，种子必须保持随机。
  const mergeMatch = source.match(/function mergeWorkflowParams\(prev, incoming\) \{([\s\S]*?)\n\}/)
  assert.ok(mergeMatch, '必须定义 mergeWorkflowParams 保护生成页输入')
  const mergeWorkflowParams = new Function('prev', 'incoming', mergeMatch[1])
  const kept = mergeWorkflowParams(
    { positive: '我的猫', negative: '低质量', seed: -1 },
    { positive: 'workflow old prompt', negative: 'workflow old negative', seed: 12345, steps: 30 },
  )
  assert.equal(kept.positive, '我的猫', '换工作流不能覆盖用户已输入的正面提示词')
  assert.equal(kept.negative, '低质量', '换工作流不能覆盖用户已输入的负面提示词')
  assert.equal(kept.seed, -1, '换工作流不能把随机种子改成工作流保存的固定种子')
  assert.equal(kept.steps, 30, '技术参数仍应由工作流回填')
  const blank = mergeWorkflowParams({ positive: '', negative: '', seed: 42 }, { positive: 'workflow prompt', seed: 999 })
  assert.equal(blank.positive, 'workflow prompt', '提示词为空时才回填工作流自带提示词')
  assert.equal(blank.seed, 42, '用户明确固定的种子必须保留')
  assert.ok(!/setParams\(\(prev\) => \(\{ \.\.\.prev, \.\.\.\(data\.params \?\? \{\}\) \}\)\)/.test(source), '工作流 params 不能直接整体覆盖')
  assert.ok(/seed: -1, batch: 1/.test(source), '默认种子必须为 -1（随机）')
  assert.ok(/onClick: \(\) => setParams\(\(prev\) => \(\{ \.\.\.prev, seed: -1 \}\)\)/.test(source), '必须提供一键恢复随机种子')
  // 图库：用户指定目录 + 删除 + 打开文件夹
  assert.ok(/libraryDir: '', \/\/ 图片库文件夹/.test(source), 'DEFAULT_SETTINGS 必须有 libraryDir')
  assert.ok(/call\('\/library-open'/.test(source), '必须调用 /library-open 打开文件夹')
  assert.ok(/call\('\/library-file\?name=' \+ encodeURIComponent\(name\) \+ \(dir/.test(source), '删除图片必须带上目录参数')
  assert.ok(/method: 'DELETE'/.test(source), '删除图片必须用 DELETE 请求')
  assert.ok(/onDelete: selectMode \? undefined/.test(source), '图库必须提供删除入口')
  assert.ok(/applyLibraryDir\(/.test(source), '必须能应用用户指定的图库目录')
  // 回归：刷新绝不能把用户正在输入的图库路径覆盖回默认目录。
  const refreshBlock = source.match(/const refreshLibrary = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[call, settings\.libraryDir, settings\.imageLimit\]\)/)
  assert.ok(refreshBlock, '应能定位 refreshLibrary 定义')
  assert.ok(!/setLibraryDirInput\(/.test(refreshBlock[1]), 'refreshLibrary 不能调用 setLibraryDirInput，否则会冲掉用户输入')
  assert.ok(/setLibraryActiveDir\(data\.dir/.test(refreshBlock[1]), '刷新只更新实际目录显示')
  assert.ok(/libraryInputInitRef/.test(source), '输入框应有独立的初始化标记')
  assert.ok(/恢复默认/.test(source), '图库页应有恢复默认按钮')
  // 图库控制区固定 + 列表独立滚动 + 只显示 60 张
  assert.ok(/\.ccd-library \{ display:flex; flex-direction:column; height:100%/.test(source), '图库页必须用 flex 撑满高度')
  assert.ok(/\.ccd-library-scroll \{ flex:1; min-height:0; overflow:auto/.test(source), '图片列表必须独立滚动')
  assert.ok(/\.ccd-body\.ccd-body-fixed \{ display:flex; flex-direction:column; overflow:hidden/.test(source), '图库 tab 的 ccd-body 不能双重滚动')
  assert.ok(/className: 'ccd-library'/.test(source) && /ccd-library-fixed/.test(source), '图库必须拆成固定控制区与滚动列表')
  // 显示张数可调，默认全部（不限）
  assert.ok(/imageLimit: '0', \/\/ 图库显示张数/.test(source), 'DEFAULT_SETTINGS 必须有 imageLimit 且默认全部')
  assert.ok(/h\('option', \{ value: '0' \}, '全部（不限张数）'\)/.test(source), '图库必须有"全部"选项')
  assert.ok(/call\('\/images\?limit=' \+ encodeURIComponent\(String\(settings\.imageLimit/.test(source), '图库请求必须用可调 limit')
  const storeSource = fs.readFileSync(path.join(ROOT, 'lib/store.js'), 'utf8')
  assert.ok(/raw <= 0 \? 0 : Math\.min\(Math\.floor\(raw\), 5000\)/.test(storeSource), 'Host 必须支持 limit<=0 不限张数')
  const callPaths = [...source.matchAll(/\bcall\('([^']+)'/g)].map((item) => item[1])
  assert.ok(callPaths.length >= 10, 'call() 数量异常，自检需更新')
  for (const p of callPaths) {
    assert.ok(
      withPluginPrefix(p).startsWith('/api/dsh-comfyui-desk/'),
      `调用路径 ${p} 补全后必须以 /api/dsh-comfyui-desk/ 开头，实际 ${withPluginPrefix(p)}`,
    )
  }
  console.log(`客户端请求路径 OK：${callPaths.length} 个 call 均带插件前缀`)
}

// 图形化回归：状态卡/生成进度必须走水平进度条，且 Host 要提供利用率字段。
{
  const source = fs.readFileSync(path.join(ROOT, 'client.body.js'), 'utf8')
  assert.ok(/function Meter\(/.test(source), '必须定义 Meter 水平进度条组件')
  assert.ok(!/function Gauge\(|strokeDasharray/.test(source), '不应再有环形仪表残留')
  assert.ok(/\.ccd-meter-track > i \{ display:block/.test(source), 'Meter 必须用直线条填充宽度')
  assert.ok(/hasGpuUtil \? 'GPU 利用率' : '显存占用'/.test(source), 'GPU 卡要有利用率/显存两种条形')
  assert.ok(/hasCpuUtil \? 'CPU 使用率' : '内存占用'/.test(source), 'CPU 卡要有利用率/内存两种条形')
  assert.ok(/progress && promptId[\s\S]{0,400}h\(Meter, \{/.test(source), '生成进度必须用水平条')
  const comfy = fs.readFileSync(path.join(ROOT, 'lib/comfy.js'), 'utf8')
  assert.ok(/cpuUsage: cpuUsagePercent\(\)/.test(comfy), 'probe 必须返回 cpuUsage')
  assert.ok(/gpuUsage,/.test(comfy), 'probe 必须返回 gpuUsage')
  const usage = cpuUsagePercent()
  assert.ok(usage === null || (usage >= 0 && usage <= 100), 'cpuUsagePercent 应返回 null 或 0-100')
  console.log('图形化状态 OK：GPU/CPU 水平进度条 + 生成进度条 + 利用率采样')
}

// 模拟 DSH 客户端加载器，确认模块会注册侧边栏入口和主区面板。
{
  const registrations = []
  let loaded
  const slots = {
    inject(name, callback) {
      callback()
      return () => {}
    },
    register(spec, component) {
      registrations.push({ slot: spec.name, spec, component })
      return () => {}
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })
  assert.ok(loaded, 'client.js 必须调用 __ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-comfyui-desk', 'loader id 必须等于包名')
  const mod = loaded.factory(() => ({ createElement: () => ({}), useCallback: () => {}, useEffect: () => {}, useMemo: () => {}, useRef: () => {}, useState: () => {} }))
  assert.equal(Array.from(mod.inject).join(','), 'slots')
  assert.equal(typeof mod.apply, 'function')
  mod.apply({ get: (name) => (name === 'slots' ? slots : undefined), effect: (callback) => callback() })
  const sidebar = registrations.find((item) => item.slot === 'sidebar.panellist')
  const main = registrations.find((item) => item.slot === 'main')
  assert.ok(sidebar, '必须注册 sidebar.panellist（DSH 左侧栏入口）')
  assert.equal(sidebar.spec.id, 'dsh-comfyui-desk')
  assert.equal(sidebar.spec.label(), 'ComfyUI 工作台')
  assert.ok(main, '必须注册 main（主区面板）')
  assert.equal(main.spec.key, 'dsh-comfyui-desk')
  console.log('客户端入口 OK：sidebar.panellist + main')
}

const routePaths = makeRoutes({}, {}).map((route) => route.path)
assert.equal(new Set(routePaths).size, routePaths.length, 'Host 路由 path 不能重复（DSH webServer 按 path 去重）')
assert.ok(routePaths.includes('/api/dsh-comfyui-desk/status'), '必须保留 /api 前缀路由')
assert.ok(routePaths.includes('/dsh-comfyui-desk/status'), '必须注册无 /api 前缀的兼容路由')
assert.ok(routePaths.includes('/api/dsh-comfyui-desk/llm-models'), '必须注册 DSH 模型库路由')
for (const suffix of ['workflow-apply', 'workflow-save', 'workflow-revision', 'bridge-status', 'library-open']) {
  assert.ok(routePaths.includes('/api/dsh-comfyui-desk/' + suffix), '缺少路由 ' + suffix)
}
console.log('路由唯一性 OK：' + routePaths.length + ' 条 exact 路由')

const objectInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model.safetensors']] } } },
  CLIPTextEncode: { input: { required: { text: [''], clip: ['CLIP'] } } },
  KSampler: {
    input: {
      required: {
        seed: [0], steps: [20], cfg: [8],
        sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']],
        denoise: [1],
      },
    },
  },
}

const prompt = buildTxt2Img(objectInfo, { positive: 'a cat', negative: 'blurry', width: 768, height: 512, steps: 30, cfg: 6.5 })
assert.equal(prompt['2'].inputs.text, 'a cat')
assert.equal(prompt['4'].inputs.width, 768)
assert.equal(prompt['5'].inputs.steps, 30)
assert.equal(prompt['5'].inputs.cfg, 6.5)
console.log('内置文生图模板 OK')

const mapping = describeMapping(prompt, objectInfo)
assert.ok(mapping.slots.positive === '2')
assert.ok(mapping.slots.negative === '3')
assert.ok(mapping.slots.sampler === '5')
assert.ok(mapping.editable.some((item) => item.key === 'steps'))
console.log('节点映射 OK：' + mapping.nodes.length + ' 个节点')

const applied = applyOverrides(prompt, { positive: 'a dog', steps: 12, seed: 42 }, { '7.filename_prefix': 'test' })
assert.equal(applied.prompt['2'].inputs.text, 'a dog')
assert.equal(applied.prompt['5'].inputs.steps, 12)
assert.equal(applied.prompt['5'].inputs.seed, 42)
assert.equal(applied.prompt['7'].inputs.filename_prefix, 'test')
console.log('参数覆盖 OK')

const uiGraph = {
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['m.safetensors'], inputs: [], mode: 0 },
    { id: 2, type: 'CLIPTextEncode', widgets_values: ['hello'], inputs: [{ name: 'clip', link: 1 }], mode: 0 },
  ],
  links: [[1, 1, 1, 2, 0, 'CLIP']],
}
const converted = parseWorkflowDocument(uiGraph, objectInfo)
assert.equal(converted.prompt['1'].inputs.ckpt_name, 'm.safetensors')
assert.equal(converted.prompt['2'].inputs.text, 'hello')
assert.deepEqual(converted.prompt['2'].inputs.clip, ['1', 1])
console.log('画布图 → API 图 OK')

// 回归防护：KSampler 的画布专用 control_after_generate 不能让 steps/cfg/sampler 整体错位。
{
  const kSamplerGraph = {
    nodes: [{
      id: 5, type: 'KSampler', mode: 0, inputs: [],
      widgets_values: [12345, 'randomize', 30, 6.5, 'dpmpp_2m', 'karras', 0.8],
    }],
    links: [],
  }
  const k = parseWorkflowDocument(kSamplerGraph, objectInfo)
  assert.equal(k.params.steps, 30, 'steps 不能被 randomize 顶掉')
  assert.equal(k.params.cfg, 6.5, 'cfg 不能被 steps 顶掉')
  assert.equal(k.params.sampler_name, 'dpmpp_2m', 'sampler_name 不能被 cfg 顶掉')
  assert.equal(k.params.scheduler, 'karras', 'scheduler 不能被 sampler_name 顶掉')
  assert.equal(k.params.denoise, 0.8, 'denoise 不能被 scheduler 顶掉')
  assert.ok(k.warnings.some((line) => line.includes('control_after_generate')))
  console.log('KSampler 参数对齐 OK：seed 后的画布 widget 已跳过')
}

// 回归防护：画布里的 Note 注释节点不能被提交给 ComfyUI 后端，否则 400 missing_node_type。
{
  const withNote = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
    '2': { class_type: 'Note', inputs: { text: '说明文字' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'hello', clip: ['1', 1] } },
  }
  const result = sanitizePrompt(withNote, objectInfo)
  assert.ok(!('2' in result.prompt), 'Note 节点必须从提交给后端的 prompt 中移除')
  assert.equal(result.prompt['3'].inputs.text, 'hello')
  assert.ok(result.warnings.some((line) => line.includes('Note')), '应给出跳过警告')

  const rerouted = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
    '2': { class_type: 'Reroute', inputs: { source: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['2', 0] } },
  }
  const bypassed = sanitizePrompt(rerouted, objectInfo)
  assert.deepEqual(bypassed.prompt['3'].inputs.clip, ['1', 1], 'Reroute 移除后下游应接到上游')

  const uiWithNote = {
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['m.safetensors'], inputs: [], mode: 0 },
      { id: 2, type: 'Note', widgets_values: ['仅注释'], inputs: [], mode: 0 },
    ],
    links: [],
  }
  const parsed = parseWorkflowDocument(uiWithNote, objectInfo)
  assert.ok(!('2' in parsed.prompt), 'parseWorkflowDocument 也必须清理 Note 节点')
  console.log('界面节点清理 OK：Note/Reroute 不再提交给 ComfyUI 后端')
}

// 工作流画布数据：节点带坐标/端口，连线带 from/to 与槽位，供前端画图。
{
  const graph = {
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', title: '大模型', pos: [10, 20], size: [200, 90], mode: 0,
        inputs: [], outputs: [{ name: 'MODEL', links: [7] }], widgets_values: ['m.safetensors'] },
      { id: 5, type: 'KSampler', pos: [300, 20], size: [220, 140], mode: 0,
        inputs: [{ name: 'model', link: 7 }], outputs: [], widgets_values: [1, 'fixed', 20] },
    ],
    links: [[7, 1, 0, 5, 0, 'MODEL']],
    groups: [],
  }
  const canvas = extractCanvas(graph, objectInfo)
  assert.equal(canvas.nodes.length, 2)
  assert.deepEqual(canvas.nodes[0].pos, [10, 20])
  assert.equal(canvas.nodes[0].title, '大模型')
  assert.equal(canvas.nodes[0].outputs[0].links[0], 7)
  assert.deepEqual(canvas.links[0], { id: 7, from: '1', fromSlot: 0, to: '5', toSlot: 0, type: 'MODEL' })
  const parsed = parseWorkflowDocument(graph, objectInfo)
  assert.equal(parsed.canvas.nodes.length, 2, 'parseWorkflowDocument 必须返回 canvas')
  const apiOnly = parseWorkflowDocument({ '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } }, objectInfo)
  assert.equal(apiOnly.canvas.nodes.length, 0, 'API 格式没有画布数据')
  console.log('工作流画布数据 OK：节点坐标/端口 + 连线槽位')
}

// AI 自选工作流：用途分类 + 中文优先 + 名字容错匹配。
{
  const fixtures = [
    { name: 'SD15_文生图', types: ['CheckpointLoaderSimple', 'EmptyLatentImage'], path: 'a' },
    { name: 'SD15_中文文生图', types: ['ZHTranslateCLIPTextEncode'], path: 'b' },
    { name: 'SD15_图生图', types: ['LoadImage', 'VAEEncode'], path: 'c' },
    { name: 'SeedVR2_图片放大', types: ['LoadImage', 'SeedVR2VideoUpscaler'], path: 'd' },
    { name: 'Wan2.2_文生视频', types: ['UNETLoader', 'CreateVideo'], path: 'e' },
  ]
  assert.equal(classifyWorkflow(fixtures[2]).purpose, '图生图')
  assert.ok(classifyWorkflow(fixtures[2]).needsSource, '图生图必须标记需要源图')
  assert.equal(classifyWorkflow(fixtures[3]).purpose, '高清放大', '图片放大不能被 SeedVR2VideoUpscaler 误判为视频')
  assert.equal(classifyWorkflow(fixtures[4]).purpose, '视频')
  assert.equal(pickWorkflow(fixtures, { purpose: '文生图', chinese: true })?.name, 'SD15_中文文生图', '中文提示词应优先中文工作流')
  assert.equal(pickWorkflow(fixtures, { purpose: '文生图', chinese: false })?.name, 'SD15_文生图', '英文提示词应优先非中文工作流')
  assert.equal(pickWorkflow(fixtures, { purpose: '图生图', requireNoSource: true }), null, '自动挑选必须排除需要源图的工作流')
  console.log('AI 自选工作流分类 OK：用途/中文优先/源图过滤')
}

// 容错匹配：AI 传近似名字（缺下划线/空格/大小写）也能命中真实工作流。
{
  const os = await import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wf-fuzzy-'))
  fs.writeFileSync(path.join(dir, 'SD15_文生图.json'), JSON.stringify({
    nodes: [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['m.safetensors'] }], links: [],
  }), 'utf8')
  for (const typed of ['SD15文生图', 'sd15 文生图', 'SD15-文生图']) {
    const found = await readWorkflow('http://127.0.0.1:8188', { dirs: [dir] }, typed)
    assert.equal(found.name, 'SD15_文生图', `容错匹配应命中：${typed}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('工作流容错匹配 OK：近似名字可命中')
}

assert.equal(normalizeBase('127.0.0.1:8188/'), 'http://127.0.0.1:8188')
assert.equal(progressOf({ status: { status_str: 'success', completed: true, messages: [['progress', { value: 20, max: 20 }]] } }).percent, 100)
assert.equal(collectImages({ outputs: { '7': { images: [{ filename: 'a.png' }] } } })[0].filename, 'a.png')
console.log('工具函数 OK')

// 工作流自动识别：临时目录里放一份最小画布格式工作流。
{
  const os = await import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-comfyui-wf-'))
  const document = { nodes: [{ id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['m.safetensors'] }], links: [] }
  fs.writeFileSync(path.join(dir, '自检工作流.json'), JSON.stringify(document), 'utf8')
  const discovered = await listWorkflows('http://127.0.0.1:8188', { dirs: [dir] })
  assert.equal(discovered.source, 'disk')
  assert.ok(discovered.items.some((item) => item.name === '自检工作流'), '必须识别到磁盘上的工作流')
  const loaded = await readWorkflow('http://127.0.0.1:8188', { dirs: [dir] }, '自检工作流')
  assert.equal(loaded.document.nodes[0].type, 'CheckpointLoaderSimple')
  // 配置里 workflowDirs 为空数组时，必须回退自动推导，否则「找不到工作流」。
  const source = fs.readFileSync(path.join(ROOT, 'lib/workflows.js'), 'utf8')
  assert.ok(/configured && configured.length > 0/.test(source), '空数组 dirs 必须回退自动推导')
  await assert.rejects(() => readWorkflow('http://127.0.0.1:8188', { dirs: [dir] }, path.join(os.tmpdir(), 'win.ini')))
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('工作流自动识别 OK（含空数组 dirs 回退）')
}

// 双向同步：画布改动写回 ComfyUI 原始 UI 文档，版本号随之变化供轮询发现。
{
  const os = await import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-comfyui-sync-'))
  const file = path.join(dir, '同步测试.json')
  fs.writeFileSync(file, JSON.stringify({
    nodes: [{ id: 7, type: 'KSampler', pos: [10, 20], widgets_values: [123, 20, 7] }],
    links: [],
  }), 'utf8')
  const base = 'http://127.0.0.1:8188'
  const before = await workflowRevision(base, { dirs: [dir] }, '同步测试')
  const moved = await writeWorkflow(base, { dirs: [dir] }, '同步测试',
    (doc) => applyCanvasEdit(doc, { op: 'move', id: 7, x: 100, y: 200 }))
  assert.deepEqual(moved.document.nodes[0].pos, [100, 200])
  assert.notEqual(moved.revision, before.revision, '写回后版本号必须变化，DSH 才能识别')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).nodes[0].pos, [100, 200], '磁盘文件必须同步更新')
  const edited = await writeWorkflow(base, { dirs: [dir] }, '同步测试',
    (doc) => applyCanvasEdit(doc, { op: 'widget', id: 7, index: 1, value: '30' }))
  assert.equal(edited.document.nodes[0].widgets_values[1], 30, '数字控件应写回数字类型')
  assert.throws(() => applyCanvasEdit({ nodes: [] }, { op: 'move', id: 9, x: 1, y: 2 }), /找不到节点/)
  await assert.rejects(() => writeWorkflow(base, { dirs: [dir] }, '不存在的工作流', (doc) => doc))
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('双向同步写回 OK：坐标/控件写盘 + 版本号变化')
}

// 图库：用户指定目录覆盖配置目录，图片可列出 / 保存 / 删除。
{
  const { resolveLibraryDir, listImages, saveImage, readImage, deleteImage } = await import('../lib/store.js')
  const os = await import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-comfyui-lib-'))
  const config = { libraryDir: path.join(dir, '未使用') }
  assert.equal(resolveLibraryDir(config, dir), path.resolve(dir), '面板指定的目录必须覆盖配置目录')
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const saved = await saveImage(config, bytes, '测试图.png', dir)
  assert.equal(saved.path, path.join(dir, '测试图.png'))
  assert.ok(saved.url.includes('dir=' + encodeURIComponent(dir)), '图片 URL 必须带目录参数')
  const listed = await listImages(config, 60, dir)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, '测试图.png')
  assert.ok(listed[0].url.includes('dir='), '列表里的图片 URL 必须带目录参数')
  assert.equal((await readImage(config, '测试图.png', dir)).bytes.length, bytes.length)
  await deleteImage(config, '测试图.png', dir)
  assert.equal((await listImages(config, 60, dir)).length, 0, '删除后目录里不应再有图片')
  await assert.rejects(() => deleteImage(config, '..', dir), /图片名不合法/, '必须拒绝路径穿越')
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('图库 OK：自定义目录读写删 + URL 带 dir + 防路径穿越')
}

{
  const names = []
  registerTools({ tools: { register: (definition) => { names.push(definition.name) } } }, {})
  assert.ok(names.includes('comfy_desk_workflows'), '必须注册工作流列表工具')
  assert.ok(names.includes('comfy_desk_workflow_map'))
  assert.ok(names.includes('comfy_desk_draw'), '必须注册 comfy_desk_draw（对话里直接画图并返回图片）')
  const toolsSource = fs.readFileSync(path.join(ROOT, 'lib/tools.js'), 'utf8')
  assert.ok(/base \+ '\/view\?filename='/.test(toolsSource), 'draw 返回的图片链接必须是 ComfyUI 绝对地址（对话内可显示）')
  assert.ok(/batch: int\('一次画几张/.test(toolsSource), 'draw 必须支持一次画多张')
  // AI 自选工作流：未指定 workflowName 时自动按意图挑选，且工具描述要告知 AI 无需手动查列表。
  assert.ok(/async function resolveWorkflow\(/.test(toolsSource), '必须有自动挑选工作流的辅助函数')
  assert.ok(/function detectPurpose\(/.test(toolsSource), '必须能从画面描述识别用途（文生图/视频/放大等）')
  assert.ok(/const chosen = await resolveWorkflow\(base, cfg, args\)/.test(toolsSource), 'draw 必须调用自动挑选')
  assert.ok(/AI 自选工作流/.test(toolsSource), '自选后应在结果里说明用了哪个工作流')
  assert.ok(/工作流会自动选/.test(toolsSource), 'draw 描述必须告知 AI 会自动选工作流')
  assert.ok(/resolveWorkflow\(base, cfg, args\)\.catch/.test(toolsSource), '自动挑选失败要能回退内置模板')
  console.log(`Agent 工具 OK：${names.length} 个`)
}

// DSH 模型库：列分组、默认选择、写提示词的数组 content 与回退。
{
  const requests = []
  const llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
    listModels: async (provider) => (provider === 'deepseek-official'
      ? [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] : []),
    stream: async function* (req) {
      requests.push(req)
      yield { type: 'text-delta', text: 'a cat, cinematic' }
    },
  }
  const ctx = {
    get: (name) => {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }
      }
      return undefined
    },
  }
  const catalog = await listChatModels(ctx)
  assert.equal(catalog.groups.length, 1)
  assert.equal(catalog.groups[0].models[0].id, 'deepseek-v4-flash')
  assert.deepEqual(defaultSelection(ctx), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  const prompt = await writePromptWith(ctx, { idea: '一只猫' })
  assert.equal(prompt, 'a cat, cinematic')
  assert.equal(requests[0].provider, 'deepseek-official')
  assert.equal(requests[0].model, 'deepseek-v4-flash')
  assert.ok(Array.isArray(requests[0].messages[0].content), 'message.content 必须是数组')
  assert.equal(requests[0].messages[0].content[0].type, 'text')
  // 显式指定模型优先于默认
  await writePromptWith(ctx, { idea: 'x', provider: 'p2', model: 'm2' })
  assert.equal(requests[1].provider, 'p2')
  console.log('DSH 模型库 + 写提示词 OK')
}

try {
  const response = await fetch('http://127.0.0.1:8188/system_stats', { signal: AbortSignal.timeout(3000) })
  if (response.ok) {
    const stats = await response.json()
    console.log(`本机 ComfyUI 在线：${stats?.system?.comfyui_version ?? '版本未知'}`)
  } else {
    console.log('本机 ComfyUI 返回 HTTP ' + response.status + '（跳过在线检查）')
  }
} catch {
  console.log('本机 ComfyUI 未连接（跳过在线检查）')
}

console.log('全部自检通过')
