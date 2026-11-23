/**
 * dsh-comfyui-desk 浏览器侧可读源码。
 * 只 require('react')，CJS 形态；client.js 由 tools/build-client.mjs 从本文件生成。
 *
 * 右侧栏三个页签：
 *   生成   —— GPU/CPU/队列状态、提示词/参数、进度、结果图片、存入图片库
 *   工作流 —— 载入 ComfyUI 工作流 JSON，查看节点映射并直接改节点输入
 *   图片库 —— 指定文件夹、浏览图片、放大预览、删除、打开文件夹
 */

const React = require('react')
const h = React.createElement
const { useCallback, useEffect, useMemo, useRef, useState } = React

const PKG = 'dsh-comfyui-desk'
const TAB_ID = PKG
const TAB_KIND = 'comfy-desk'
const NS = PKG
const SETTINGS_KEY = 'dsh-comfyui-desk:settings:v1'
const DEFAULT_SETTINGS = {
  base: 'http://127.0.0.1:8188',
  llmSelection: '', // "provider|model"，来自 DSH 模型库；留空则用 DSH 当前会话模型
  selectedWorkflow: '', // 上次选择的工作流名，重开面板后自动恢复
  syncCanvas: '1', // '1' 开启与 ComfyUI 的画布双向同步，'0' 关闭
  libraryDir: '', // 图片库文件夹；留空用 Host 默认目录
  imageLimit: '0', // 图库显示张数；'0' = 不限制（显示全部）
}
const selectionValue = (provider, model) => (provider && model ? provider + '|' + model : '')
const DEFAULT_PARAMS = {
  checkpoint: '', positive: '', negative: '',
  width: 1024, height: 1024, steps: 28, cfg: 7, seed: -1, batch: 1,
  filenamePrefix: 'DSHDesk',
}

// 工作流自带 params 只能作为「未填写时的默认值」：
// - 用户已经在生成页写过的正/负提示词，绝不能被工作流里的旧提示词覆盖；
// - 种子默认随机（-1），工作流保存的固定种子不能悄悄把随机模式改掉。
function mergeWorkflowParams(prev, incoming) {
  if (!incoming || typeof incoming !== 'object') return prev
  const merged = { ...prev, ...incoming }
  for (const key of ['positive', 'negative']) {
    if (String(prev[key] ?? '').trim() !== '') merged[key] = prev[key]
  }
  const seedText = String(prev.seed ?? '').trim()
  const seedValue = Number(seedText)
  merged.seed = seedText !== '' && Number.isFinite(seedValue) && seedValue >= 0 ? prev.seed : -1
  return merged
}

function serviceOf(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch (error) { /* fall through */ }
  try {
    const value = ctx[name]
    if (value !== undefined && value !== null) return value
  } catch (error) { /* ignore */ }
  return undefined
}

function gb(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 GB'
  return (value / 1073741824).toFixed(1) + ' GB'
}

function short(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : value.slice(0, max) + '…'
}

// 比较目录是否同一个（忽略斜杠方向和大小写），用于检测 Host 是否真的按指定目录返回。
function sameDir(a, b) {
  const norm = (value) => String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}
const HOST_STALE_TIP = 'Host 端还是旧版本：请完全退出 DSH 进程后重新启动（窗口里的「重启」不会重新加载插件代码）。'

function readSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch (error) {
    return { ...DEFAULT_SETTINGS }
  }
}

function writeSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch (error) { /* ignore */ }
}

function withBase(path, base) {
  if (!base || base === DEFAULT_SETTINGS.base) return path
  return path + (path.includes('?') ? '&' : '?') + 'base=' + encodeURIComponent(base)
}

// 所有 call() 传的是短路径（/status、/images...），host 路由带插件前缀。
// 统一补全，避免请求 /status 得到 404。
function withPluginPrefix(path) {
  if (path.startsWith('/api/') || path.startsWith('/dsh-comfyui-desk/')) return path
  return '/api/dsh-comfyui-desk' + (path.startsWith('/') ? path : '/' + path)
}

async function api(path, options) {
  const opts = options ?? {}
  const url = withBase(withPluginPrefix(path), opts.base)
  const candidates = [url]
  if (url.startsWith('/api/')) candidates.push(url.slice(4)) // /api/xxx → /xxx，兼容 DSH 转发差异
  let response
  let lastError
  for (const candidate of candidates) {
    try {
      response = await fetch(candidate, {
        method: opts.method ?? 'GET',
        headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
      if (response.status === 404 || response.status === 403) {
        lastError = new Error('HTTP ' + response.status)
        response = undefined
        continue
      }
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!response) throw new Error('连不上 DSH Host：' + (lastError?.message ?? String(lastError ?? '未知错误')))
  if (opts.raw) {
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return response
  }
  const data = await response.json().catch(() => ({ ok: false, error: 'Host 返回的不是 JSON' }))
  if (!response.ok || data.ok === false) throw new Error(data.error ?? ('HTTP ' + response.status))
  return data
}

const STYLE = `
.ccd { --ccd-bg: var(--dsw-alias-bg-container, #ffffff); --ccd-panel: var(--dsw-alias-bg-body, #f7f8fa);
  --ccd-fg: var(--dsw-alias-text-primary, #1f2329); --ccd-dim: var(--dsw-alias-text-secondary, #646a73);
  --ccd-line: var(--dsw-alias-border, #e5e6eb); --ccd-accent: var(--dsw-alias-primary, #3370ff);
  --ccd-ok: #2ea121; --ccd-warn: #d89614; --ccd-bad: #d92b2b; --ccd-radius: 8px;
  color: var(--ccd-fg); background: var(--ccd-bg); font-size: 13px; line-height: 1.5; height: 100%;
  display: flex; flex-direction: column; overflow: hidden; }
@media (prefers-color-scheme: dark) { .ccd { --ccd-bg: var(--dsw-alias-bg-container, #1f1f1f);
  --ccd-panel: var(--dsw-alias-bg-body, #252526); --ccd-fg: var(--dsw-alias-text-primary, #e6e6e6);
  --ccd-dim: var(--dsw-alias-text-secondary, #a0a0a0); --ccd-line: var(--dsw-alias-border, #3a3a3a);
  --ccd-accent: var(--dsw-alias-primary, #4c8dff); } }
.ccd * { box-sizing: border-box; }
.ccd-head { display:flex; align-items:center; gap:6px; padding:10px 12px; border-bottom:1px solid var(--ccd-line); flex-wrap:wrap; }
.ccd-title { font-weight:600; font-size:14px; margin-right:auto; }
.ccd-tabs { display:flex; gap:4px; padding:8px 12px 0; border-bottom:1px solid var(--ccd-line); }
.ccd-tab { border:0; background:transparent; color:var(--ccd-dim); padding:6px 10px; cursor:pointer;
  border-bottom:2px solid transparent; font-size:13px; }
.ccd-tab.on { color:var(--ccd-accent); border-bottom-color:var(--ccd-accent); font-weight:600; }
.ccd-body { flex:1; overflow:auto; padding:12px; }
.ccd-body.ccd-body-fixed { display:flex; flex-direction:column; overflow:hidden; }
.ccd-card { background:var(--ccd-panel); border:1px solid var(--ccd-line); border-radius:var(--ccd-radius);
  padding:10px; margin-bottom:10px; }
.ccd-card h4 { margin:0 0 8px; font-size:13px; font-weight:600; }
.ccd-stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.ccd-stat { background:var(--ccd-panel); border:1px solid var(--ccd-line); border-radius:var(--ccd-radius); padding:8px; min-width:0; }
.ccd-stat b { display:block; font-size:12px; color:var(--ccd-dim); font-weight:500; margin-bottom:3px; }
.ccd-stat span { font-size:13px; overflow-wrap:anywhere; }
.ccd-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; background:var(--ccd-bad); }
.ccd-dot.on { background:var(--ccd-ok); }
.ccd-row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
.ccd-row > label { width:64px; flex:none; color:var(--ccd-dim); }
.ccd-row > input, .ccd-row > select, .ccd-field, .ccd-area { flex:1; min-width:0; background:var(--ccd-bg);
  color:var(--ccd-fg); border:1px solid var(--ccd-line); border-radius:6px; padding:6px 8px; font:inherit; }
.ccd-area { width:100%; min-height:74px; resize:vertical; display:block; margin-bottom:8px; }
.ccd-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.ccd-btn { border:1px solid var(--ccd-line); background:var(--ccd-panel); color:var(--ccd-fg);
  border-radius:6px; padding:6px 10px; cursor:pointer; font:inherit; white-space:nowrap; }
.ccd-btn:hover { border-color:var(--ccd-accent); }
.ccd-btn.primary { background:var(--ccd-accent); color:#fff; border-color:var(--ccd-accent); font-weight:600; }
.ccd-btn:disabled { opacity:.5; cursor:not-allowed; }
.ccd-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.ccd-msg { color:var(--ccd-warn); font-size:12px; min-height:18px; overflow-wrap:anywhere; }
.ccd-bar { height:6px; border-radius:4px; background:var(--ccd-line); overflow:hidden; margin:8px 0; }
.ccd-bar > i { display:block; height:100%; background:var(--ccd-accent); transition:width .2s; }
.ccd-meter { margin-bottom:10px; }
.ccd-meter:last-child { margin-bottom:0; }
.ccd-meter-head { display:flex; justify-content:space-between; align-items:baseline; font-size:12px; margin-bottom:4px; }
.ccd-meter-head > span { color:var(--ccd-dim); }
.ccd-meter-head > b { font-size:13px; font-variant-numeric:tabular-nums; }
.ccd-meter-track { height:8px; border-radius:4px; background:var(--ccd-line); overflow:hidden; }
.ccd-meter-track > i { display:block; height:100%; border-radius:4px; transition:width .25s; }
.ccd-meter-detail { font-size:11px; color:var(--ccd-dim); margin-top:4px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 图库页：控制区固定在顶部，只有图片列表滚动。 */
.ccd-library { display:flex; flex-direction:column; height:100%; min-height:0; }
.ccd-library-fixed { flex:none; }
.ccd-library-scroll { flex:1; min-height:0; overflow:auto; padding-right:2px; }
.ccd-thumbs { display:grid; grid-template-columns:repeat(auto-fill,minmax(84px,1fr)); gap:8px; }
.ccd-thumb { position:relative; border:1px solid var(--ccd-line); border-radius:6px; overflow:hidden;
  background:var(--ccd-panel); cursor:pointer; aspect-ratio:1; }
.ccd-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
.ccd-thumb small { position:absolute; left:0; right:0; bottom:0; background:rgba(0,0,0,.55); color:#fff;
  font-size:10px; padding:2px 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ccd-thumb[data-sel="1"] { outline:2px solid var(--ccd-accent); outline-offset:-2px; }
.ccd-thumb .ccd-check { position:absolute; left:3px; top:3px; z-index:2; width:16px; height:16px;
  accent-color:var(--ccd-accent); cursor:pointer; }
.ccd-thumb .ccd-del { position:absolute; right:2px; top:2px; z-index:2; padding:1px 5px; font-size:11px; line-height:1.4; }
.ccd-path { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ccd-path code { flex:1; min-width:120px; background:var(--ccd-bg); border:1px solid var(--ccd-line);
  border-radius:5px; padding:5px 7px; font-size:11px; color:var(--ccd-dim); overflow-wrap:anywhere; }
.ccd-node { border:1px solid var(--ccd-line); border-radius:6px; padding:8px; margin-bottom:8px; background:var(--ccd-panel); }
.ccd-node .hd { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
.ccd-node .id { color:var(--ccd-dim); font-size:11px; }
.ccd-node .type { color:var(--ccd-accent); font-weight:600; overflow-wrap:anywhere; }
.ccd-input { display:flex; gap:6px; align-items:center; margin-top:4px; font-size:12px; }
.ccd-input .nm { width:110px; flex:none; color:var(--ccd-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ccd-input input { flex:1; min-width:0; background:var(--ccd-bg); color:var(--ccd-fg);
  border:1px solid var(--ccd-line); border-radius:5px; padding:4px 6px; font:inherit; }
.ccd-input .src { color:var(--ccd-dim); flex:1; min-width:0; overflow-wrap:anywhere; }
.ccd-lightbox { position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,.86); display:flex;
  align-items:center; justify-content:center; flex-direction:column; gap:10px; padding:24px; }
.ccd-lightbox img { max-width:100%; max-height:78vh; object-fit:contain; }
.ccd-lightbox .bar { color:#fff; display:flex; gap:10px; align-items:center; font-size:12px; }
.ccd-hint { color:var(--ccd-dim); font-size:12px; margin-top:6px; }
.ccd-select { width:100%; }
.ccd-canvas { position:relative; height:460px; overflow:hidden; border:1px solid var(--ccd-line);
  border-radius:6px; background:var(--ccd-panel); cursor:grab; touch-action:none;
  background-image:radial-gradient(var(--ccd-line) 1px, transparent 1px); background-size:20px 20px; }
.ccd-canvas.grabbing { cursor:grabbing; }
.ccd-canvas-empty { display:flex; align-items:center; justify-content:center; height:100%; color:var(--ccd-dim); font-size:12px; }
.ccd-canvas-world { position:absolute; left:0; top:0; transform-origin:0 0; }
.ccd-canvas-edges { position:absolute; left:0; top:0; overflow:visible; pointer-events:none; }
.ccd-canvas-edge { fill:none; stroke:var(--ccd-dim); stroke-width:2; opacity:.75; }
.ccd-canvas-edge-dot { fill:var(--ccd-accent); }
.ccd-cnode { position:absolute; border:1px solid var(--ccd-line); border-left:4px solid var(--ccd-accent);
  border-radius:6px; background:var(--ccd-bg); box-shadow:0 1px 3px rgba(0,0,0,.15); overflow:hidden; font-size:11px; }
.ccd-cnode[data-muted="1"] { opacity:.55; }
.ccd-cnode[data-sel="1"] { outline:2px solid var(--ccd-accent); z-index:2; }
.ccd-cnode-head { padding:3px 6px; background:var(--ccd-panel); border-bottom:1px solid var(--ccd-line);
  font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:move; }
.ccd-cnode-type { padding:2px 6px; color:var(--ccd-dim); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ccd-cnode-widget { padding:1px 6px; color:var(--ccd-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ccd-cport { position:absolute; width:8px; height:8px; border-radius:50%; background:var(--ccd-accent);
  border:1px solid var(--ccd-bg); transform:translate(-50%,-50%); }
.ccd-cport[data-side="in"] { background:var(--ccd-dim); }
.ccd-ctools { position:absolute; right:6px; bottom:6px; display:flex; gap:4px; }
.ccd-ctools button { border:1px solid var(--ccd-line); background:var(--ccd-bg); color:var(--ccd-fg);
  border-radius:5px; min-width:26px; height:24px; cursor:pointer; font-size:12px; padding:0 6px; }
.ccd-ctools button:hover { border-color:var(--ccd-accent); }
.ccd-cbar { position:absolute; left:6px; bottom:6px; display:flex; align-items:center; gap:8px;
  font-size:11px; color:var(--ccd-dim); pointer-events:none; }
.ccd-cbar button { pointer-events:auto; border:1px solid var(--ccd-line); background:var(--ccd-bg);
  color:var(--ccd-fg); border-radius:5px; height:24px; cursor:pointer; font-size:11px; padding:0 8px; }
.ccd-cbar button:hover { border-color:var(--ccd-accent); }
.ccd-cbar .ok { color:var(--ccd-ok); }
.ccd-cbar .warn { color:var(--ccd-warn); }
.ccd-cselbox { position:absolute; border:1px dashed var(--ccd-accent); background:rgba(51,112,255,.12);
  pointer-events:none; z-index:5; }
.ccd-cwidget-input { width:100%; border:0; background:transparent; color:var(--ccd-fg); font:inherit;
  font-size:10px; padding:1px 6px; border-bottom:1px solid transparent; }
.ccd-cwidget-input:focus { outline:none; border-bottom-color:var(--ccd-accent); }
`

// ---- 工作流画布：把 ComfyUI 的原始 nodes/links 画成节点图（借鉴 dsh-comfy） ----
const CC_NODE_MIN_W = 150
const CC_NODE_MAX_W = 260
const CC_NODE_MIN_H = 54
const CC_NODE_MAX_H = 150
const CC_HEAD_H = 20

function ccClamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, number))
}
function ccNodeSize(node) {
  const size = Array.isArray(node?.size) ? node.size : []
  return {
    w: ccClamp(size[0] || 200, CC_NODE_MIN_W, CC_NODE_MAX_W),
    h: ccClamp(size[1] || 70, CC_NODE_MIN_H, CC_NODE_MAX_H),
  }
}
function ccPortOffset(index, count, height) {
  const total = Math.max(1, Number(count) || 1)
  const position = ccClamp(index, 0, total - 1)
  return CC_HEAD_H + ((position + 0.5) / total) * Math.max(8, height - CC_HEAD_H)
}
function ccBezier(x1, y1, x2, y2) {
  const handle = ccClamp(Math.abs(x2 - x1) * 0.5, 24, 160)
  return 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1)
    + ' C' + (x1 + handle).toFixed(1) + ' ' + y1.toFixed(1)
    + ', ' + (x2 - handle).toFixed(1) + ' ' + y2.toFixed(1)
    + ', ' + x2.toFixed(1) + ' ' + y2.toFixed(1)
}
function ccAccentIndex(category) {
  const text = String(category ?? '')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  return hash % 6
}
const CC_CATS = ['#3370ff', '#00a870', '#d89614', '#8b5cf6', '#e36a3d', '#0ea5a5']

function WorkflowCanvas({ canvas, selectedId, onSelect, resetKey, onNodeMove, onWidgetChange, onDelete, syncLabel }) {
  const stageRef = useRef(null)
  const [view, setView] = useState({ x: 16, y: 16, k: 0.8 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(null)
  const [selected, setSelected] = useState(() => new Set())
  const [box, setBox] = useState(null)
  const [dragPos, setDragPos] = useState(null)
  const [widgetEdits, setWidgetEdits] = useState({})
  const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : []
  const links = Array.isArray(canvas?.links) ? canvas.links : []

  useEffect(() => {
    if (selectedId !== '' && selectedId !== null && selectedId !== undefined) setSelected(new Set([String(selectedId)]))
  }, [selectedId])

  const rendered = useMemo(() => nodes.map((node) => {
    const { w, h } = ccNodeSize(node)
    const moving = dragPos && String(dragPos.id) === String(node.id) ? dragPos : null
    return {
      node, x: moving ? moving.x : (Number(node.pos?.[0]) || 0),
      y: moving ? moving.y : (Number(node.pos?.[1]) || 0), w, h,
    }
  }), [nodes, dragPos])
  const byId = useMemo(() => {
    const map = new Map()
    for (const entry of rendered) map.set(String(entry.node.id), entry)
    return map
  }, [rendered])
  const edges = useMemo(() => links.map((link) => {
    const from = byId.get(String(link.from))
    const to = byId.get(String(link.to))
    if (!from || !to) return null
    const fromCount = from.node.outputs?.length || 1
    const toCount = to.node.inputs?.length || 1
    const y1 = from.y + ccPortOffset(link.fromSlot || 0, fromCount, from.h)
    const y2 = to.y + ccPortOffset(link.toSlot || 0, toCount, to.h)
    return { key: link.id, d: ccBezier(from.x + from.w, y1, to.x, y2), x: to.x, y: y2 }
  }).filter(Boolean), [links, byId])
  const bounds = useMemo(() => {
    if (rendered.length === 0) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const entry of rendered) {
      minX = Math.min(minX, entry.x); minY = Math.min(minY, entry.y)
      maxX = Math.max(maxX, entry.x + entry.w); maxY = Math.max(maxY, entry.y + entry.h)
    }
    return { minX, minY, maxX, maxY }
  }, [rendered])

  const fit = useCallback(() => {
    const box = stageRef.current?.getBoundingClientRect?.()
    if (!box || !bounds) return
    const width = box.width || 500
    const height = box.height || 460
    const pad = 20
    const boxWidth = Math.max(1, bounds.maxX - bounds.minX)
    const boxHeight = Math.max(1, bounds.maxY - bounds.minY)
    const k = ccClamp(Math.min((width - pad * 2) / boxWidth, (height - pad * 2) / boxHeight), 0.25, 1.8)
    setView({ x: (width - boxWidth * k) / 2 - bounds.minX * k, y: (height - boxHeight * k) / 2 - bounds.minY * k, k })
    setDragging(false)
    dragRef.current = null
  }, [bounds])

  // 只在切换工作流时重新适配；拖动节点改坐标时保持当前视图不动。
  useEffect(() => { if (bounds) fit() }, [resetKey])

  // 滚轮缩放：以鼠标位置为中心，和 ComfyUI 一致。
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event) => {
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      setView((prev) => {
        const k = ccClamp(prev.k * Math.exp(-event.deltaY * 0.0015), 0.1, 4)
        const ratio = k / prev.k
        return { x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio, k }
      })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const onKey = (event) => {
      const tag = window.document?.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected.size > 0 && typeof onDelete === 'function') {
        event.preventDefault()
        onDelete([...selected].map((nodeId) => Number(nodeId)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, onDelete])

  const zoomBy = (factor) => setView((prev) => {
    const box = stageRef.current?.getBoundingClientRect?.()
    const cx = (box?.width || 500) / 2
    const cy = (box?.height || 460) / 2
    const k = ccClamp(prev.k * factor, 0.1, 4)
    const ratio = k / prev.k
    return { x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio, k }
  })

  const toWorld = (clientX, clientY) => {
    const rect = stageRef.current?.getBoundingClientRect?.()
    return { x: (clientX - (rect?.left ?? 0) - view.x) / view.k, y: (clientY - (rect?.top ?? 0) - view.y) / view.k }
  }
  const onPointerDown = (event) => {
    if (event.button === 1 || event.button === 2 || event.shiftKey) {
      dragRef.current = { mode: 'pan', px: event.clientX, py: event.clientY, vx: view.x, vy: view.y }
    } else if (event.button === 0) {
      const p = toWorld(event.clientX, event.clientY)
      dragRef.current = { mode: 'box', sx: p.x, sy: p.y }
      setBox({ x: p.x, y: p.y, w: 0, h: 0 })
      setSelected(new Set())
    } else return
    setDragging(true)
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* ignore */ }
  }
  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.mode === 'pan') {
      const dx = event.clientX - drag.px
      const dy = event.clientY - drag.py
      setView((prev) => ({ ...prev, x: drag.vx + dx, y: drag.vy + dy }))
      return
    }
    const p = toWorld(event.clientX, event.clientY)
    if (drag.mode === 'box') {
      const x1 = Math.min(drag.sx, p.x), x2 = Math.max(drag.sx, p.x)
      const y1 = Math.min(drag.sy, p.y), y2 = Math.max(drag.sy, p.y)
      setBox({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
      const hits = new Set(rendered.filter((entry) =>
        entry.x < x2 && entry.x + entry.w > x1 && entry.y < y2 && entry.y + entry.h > y1,
      ).map((entry) => String(entry.node.id)))
      setSelected(hits)
      return
    }
    if (drag.mode === 'node') {
      const x = Math.round(drag.nx + (event.clientX - drag.px) / view.k)
      const y = Math.round(drag.ny + (event.clientY - drag.py) / view.k)
      drag.curX = x
      drag.curY = y
      setDragPos({ id: drag.id, x, y })
    }
  }
  const onPointerUp = () => {
    const drag = dragRef.current
    if (drag?.mode === 'node' && typeof onNodeMove === 'function') {
      onNodeMove(drag.id, drag.curX ?? drag.nx, drag.curY ?? drag.ny)
      setDragPos(null)
    }
    if (drag?.mode === 'box' && selected.size === 1 && typeof onSelect === 'function') onSelect([...selected][0])
    dragRef.current = null
    setDragging(false)
    setBox(null)
  }

  const commitWidget = (nodeId, index, value, key) => {
    setWidgetEdits((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    if (typeof onWidgetChange !== 'function') return
    const node = nodes.find((item) => String(item.id) === String(nodeId))
    if (String(node?.widgets?.[index]?.value ?? '') !== String(value)) onWidgetChange(nodeId, index, value)
  }

  if (nodes.length === 0) {
    return h('div', { className: 'ccd-canvas' },
      h('div', { className: 'ccd-canvas-empty' }, '这份工作流没有画布数据（API 格式），节点映射见下方列表'))
  }

  return h('div', {
    ref: stageRef,
    className: 'ccd-canvas' + (dragging ? ' grabbing' : ''),
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
    onContextMenu: (event) => event.preventDefault(),
  },
    h('div', { className: 'ccd-canvas-world', style: { transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')' } },
      h('svg', { className: 'ccd-canvas-edges', width: 1, height: 1 },
        edges.map((edge) => h('g', { key: edge.key },
          h('path', { className: 'ccd-canvas-edge', d: edge.d }),
          h('circle', { className: 'ccd-canvas-edge-dot', cx: edge.x, cy: edge.y, r: 2.4 })))),
      box ? h('div', { className: 'ccd-cselbox', style: {
        left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px',
      } }) : null,
      rendered.map((entry) => {
        const node = entry.node
        const cat = CC_CATS[ccAccentIndex(node.category || node.type)]
        const muted = node.mode === 2 || node.mode === 4
        const widgets = (node.widgets ?? []).slice(0, 2)
        return h('div', {
          key: 'n-' + node.id,
          className: 'ccd-cnode',
          'data-sel': selected.has(String(node.id)) ? '1' : '0',
          'data-muted': muted ? '1' : '0',
          style: {
            left: entry.x + 'px', top: entry.y + 'px', width: entry.w + 'px', height: entry.h + 'px',
            borderLeftColor: cat,
          },
          title: node.title + '（' + node.type + '）',
        },
          h('div', {
            className: 'ccd-cnode-head',
            onPointerDown: (event) => {
              if (event.button !== 0) return
              event.stopPropagation()
              const nodeId = String(node.id)
              if (event.shiftKey) setSelected((prev) => new Set(prev).add(nodeId))
              else setSelected(new Set([nodeId]))
              if (typeof onSelect === 'function') onSelect(nodeId)
              dragRef.current = {
                mode: 'node', id: nodeId, px: event.clientX, py: event.clientY,
                nx: entry.x, ny: entry.y, curX: entry.x, curY: entry.y,
              }
              setDragging(true)
              try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { /* ignore */ }
            },
          }, node.title || node.type),
          h('div', { className: 'ccd-cnode-type' }, node.type),
          widgets.map((widget, index) => {
            const key = String(node.id) + ':' + index
            const value = widgetEdits[key] !== undefined ? widgetEdits[key] : (widget.value ?? '')
            return h('input', {
              key, className: 'ccd-cwidget-input', value: String(value).slice(0, 40),
              title: '修改后按回车，同步到 ComfyUI',
              onPointerDown: (event) => event.stopPropagation(),
              onChange: (event) => setWidgetEdits((prev) => ({ ...prev, [key]: event.target.value })),
              onBlur: (event) => commitWidget(node.id, index, event.target.value, key),
              onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur() },
            })
          }),
          (node.inputs ?? []).map((input, index) => h('span', {
            key: 'i' + index, className: 'ccd-cport', 'data-side': 'in',
            style: { left: '0px', top: ccPortOffset(index, node.inputs.length, entry.h) + 'px' },
          })),
          (node.outputs ?? []).map((output, index) => h('span', {
            key: 'o' + index, className: 'ccd-cport', 'data-side': 'out',
            style: { left: entry.w + 'px', top: ccPortOffset(index, node.outputs.length, entry.h) + 'px' },
          })))
      })),
    h('div', { className: 'ccd-cbar', onPointerDown: (event) => event.stopPropagation() },
      h('span', null, Math.round(view.k * 100) + '%'),
      syncLabel ? h('span', { className: syncLabel.ok ? 'ok' : 'warn' }, syncLabel.text) : null,
      h('button', {
        title: '清除选择',
        onClick: () => { setSelected(new Set()); if (typeof onSelect === 'function') onSelect('') },
      }, '清除选择')),
    h('div', { className: 'ccd-ctools', onPointerDown: (event) => event.stopPropagation() },
      h('button', { title: '缩小', onClick: () => zoomBy(1 / 1.25) }, '−'),
      h('button', { title: '放大', onClick: () => zoomBy(1.25) }, '+'),
      h('button', { title: '适应画布', onClick: fit }, '⊡')))
}

/** 水平进度条：一眼看出占用比例与数值，比圆环更易读、更省空间。 */
function Meter({ value, max, label, detail, tone }) {
  const total = Number(max)
  const current = Number(value)
  const raw = total > 0 ? Math.round((current / total) * 100) : 0
  const pct = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0))
  const color = tone === 'bad' ? 'var(--ccd-bad)' : tone === 'ok' ? 'var(--ccd-ok)'
    : pct >= 85 ? 'var(--ccd-bad)' : pct >= 65 ? 'var(--ccd-warn)' : 'var(--ccd-accent)'
  return h('div', { className: 'ccd-meter' },
    h('div', { className: 'ccd-meter-head' },
      h('span', null, label),
      h('b', { style: { color } }, pct + '%')),
    h('div', { className: 'ccd-meter-track' },
      h('i', { style: { width: pct + '%', background: color } })),
    detail ? h('div', { className: 'ccd-meter-detail', title: detail }, detail) : null)
}

function StatusCards({ status, error }) {
  const devices = status?.devices ?? []
  const gpu = devices.length ? devices[0] : null
  const vramTotal = Number(gpu?.vram_total ?? 0)
  const vramFree = Number(gpu?.vram_free ?? 0)
  const vramUsed = Math.max(0, vramTotal - vramFree)
  const ramTotal = Number(status?.ramTotal ?? 0)
  const ramFree = Number(status?.ramFree ?? 0)
  const ramUsed = Math.max(0, ramTotal - ramFree)
  const gpuUtil = status?.gpuUsage
  const cpuUtil = status?.cpuUsage
  const hasGpuUtil = typeof gpuUtil === 'number' && Number.isFinite(gpuUtil)
  const hasCpuUtil = typeof cpuUtil === 'number' && Number.isFinite(cpuUtil)
  const gpuName = gpu ? String(gpu.name ?? gpu.type ?? 'GPU')
    .replace(/^cuda:\d+\s*/i, '').replace(/\s*:\s*cudaMallocAsync\s*$/i, '') : ''

  return h('div', null,
    h('div', { className: 'ccd-card' },
      h(Meter, {
        label: hasGpuUtil ? 'GPU 利用率' : '显存占用',
        value: hasGpuUtil ? gpuUtil : vramUsed,
        max: hasGpuUtil ? 100 : vramTotal,
        detail: gpu ? short(gpuName, 26) + ' · 显存 ' + gb(vramUsed) + '/' + gb(vramTotal) : '未报告 GPU',
      }),
      h(Meter, {
        label: hasCpuUtil ? 'CPU 使用率' : '内存占用',
        value: hasCpuUtil ? cpuUtil : ramUsed,
        max: hasCpuUtil ? 100 : ramTotal,
        detail: hasCpuUtil ? '内存 ' + gb(ramUsed) + '/' + gb(ramTotal) : gb(ramUsed) + ' / ' + gb(ramTotal) + ' 已用',
      })),
    h('div', { className: 'ccd-stats' },
      h('div', { className: 'ccd-stat' },
        h('b', null, 'ComfyUI'),
        h('span', null,
          h('i', { className: 'ccd-dot' + (status ? ' on' : '') }),
          status ? short(status.version || '已连接', 22) : short(error || '未连接', 30))),
      h('div', { className: 'ccd-stat' },
        h('b', null, '队列'),
        h('span', null, `运行 ${status?.queueRunning ?? 0} · 等待 ${status?.queuePending ?? 0}`))))
}

function ImageGrid({ images, urlOf, onOpen, onSave, saveLabel, selectable, selected, onToggle, onDelete }) {
  if (!images || images.length === 0) return h('div', { className: 'ccd-hint' }, '（暂无图片）')
  return h('div', { className: 'ccd-thumbs' }, images.map((image, index) => {
    const url = urlOf(image)
    const name = image.filename ?? image.name ?? `图片 ${index + 1}`
    const isSelected = selectable && (selected ?? []).includes(name)
    return h('div', {
      className: 'ccd-thumb', key: name + index, title: name,
      'data-sel': isSelected ? '1' : '0',
      onClick: () => (selectable ? (onToggle?.(name)) : onOpen(index)),
    },
      h('img', { src: url, alt: name, loading: 'lazy' }),
      selectable ? h('input', {
        className: 'ccd-check', type: 'checkbox', checked: isSelected,
        onClick: (event) => event.stopPropagation(),
        onChange: () => onToggle?.(name),
      }) : null,
      h('small', null, short(name, 24)),
      onDelete ? h('button', {
        className: 'ccd-btn ccd-del', title: '删除这张图片',
        onClick: (event) => { event.stopPropagation(); onDelete(image) },
      }, '删') : null,
      onSave ? h('button', {
        className: 'ccd-btn', style: { position: 'absolute', right: 2, top: 2, padding: '1px 4px', fontSize: 10 },
        title: '存入图片库', onClick: (event) => { event.stopPropagation(); onSave(image) },
      }, saveLabel ?? '存') : null)
  }))
}

function Lightbox({ items, index, onClose, onIndex, urlOf }) {
  if (!items || index < 0 || index >= items.length) return null
  const item = items[index]
  return h('div', { className: 'ccd-lightbox', onClick: onClose },
    h('img', { src: urlOf(item), alt: item.filename ?? item.name ?? '', onClick: (event) => event.stopPropagation() }),
    h('div', { className: 'ccd-bar', onClick: (event) => event.stopPropagation() },
      h('span', null, short(item.filename ?? item.name ?? '', 56)),
      h('button', { className: 'ccd-btn', onClick: () => onIndex(index - 1), disabled: index <= 0 }, '上一张'),
      h('button', { className: 'ccd-btn', onClick: () => onIndex(index + 1), disabled: index >= items.length - 1 }, '下一张'),
      h('a', { className: 'ccd-btn', href: urlOf(item), download: item.filename ?? item.name, target: '_blank', rel: 'noreferrer' }, '下载'),
      h('button', { className: 'ccd-btn', onClick: onClose }, '关闭')))
}

function ComfyDeskPanel() {
  const [settings, setSettings] = useState(readSettings)
  const [tab, setTab] = useState('generate')
  const [status, setStatus] = useState(null)
  const [models, setModels] = useState({ checkpoints: [], samplers: [], schedulers: [], loras: [] })
  const [params, setParams] = useState({ ...DEFAULT_PARAMS })
  const [overrides, setOverrides] = useState({})
  const [workflow, setWorkflow] = useState(null)
  const [workflowName, setWorkflowName] = useState('')
  const [savedWorkflows, setSavedWorkflows] = useState([])
  const [workflowInfo, setWorkflowInfo] = useState({ source: '', warning: '' })
  const [selectedWorkflow, setSelectedWorkflow] = useState(() => settings.selectedWorkflow ?? '')
  const [selectedNode, setSelectedNode] = useState('')
  const [bridgeState, setBridgeState] = useState({ installed: false, version: '' })
  const [syncRevision, setSyncRevision] = useState('')
  const [canvasKey, setCanvasKey] = useState('')
  const [history, setHistory] = useState([])
  const [library, setLibrary] = useState([])
  const [promptId, setPromptId] = useState('')
  const [progress, setProgress] = useState(null)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiIdea, setAiIdea] = useState('')
  const [msg, setMsg] = useState('')
  const [llmCatalog, setLlmCatalog] = useState({ groups: [], default: { provider: '', model: '' }, warning: '' })
  const [showSettings, setShowSettings] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [libraryDirInput, setLibraryDirInput] = useState(() => settings.libraryDir ?? '')
  const [libraryActiveDir, setLibraryActiveDir] = useState('') // Host 返回的实际生效目录，仅用于显示
  const [selectedImages, setSelectedImages] = useState([])
  const [selectMode, setSelectMode] = useState(false)
  const fileRef = useRef(null)
  const folderRef = useRef(null)
  const uploadRef = useRef(null)
  const restoredRef = useRef(false)
  const libraryInputInitRef = useRef(false) // 输入框只初始化一次，刷新不能覆盖用户正在填的值

  const call = useCallback((path, options) => api(path, { ...(options ?? {}), base: settings.base }), [settings.base])

  const refreshStatus = useCallback(() => {
    call('/status').then(setStatus).catch((error) => { setStatus(null); setMsg(error.message) })
  }, [call])
  const refreshModels = useCallback(() => {
    call('/models').then(setModels).catch(() => {})
  }, [call])
  const refreshHistory = useCallback(() => {
    call('/history?limit=24').then((data) => setHistory(data.runs ?? [])).catch(() => {})
  }, [call])
  // 刷新只更新图片列表和实际目录显示；绝不写 libraryDirInput，否则会把用户正在填的路径冲回默认。
  const refreshLibrary = useCallback(() => {
    const dir = String(settings.libraryDir ?? '').trim()
    const limit = String(settings.imageLimit ?? '0')
    call('/images?limit=' + encodeURIComponent(limit) + (dir ? '&dir=' + encodeURIComponent(dir) : ''))
      .then((data) => {
        setLibrary(data.images ?? [])
        setLibraryActiveDir(data.dir ?? dir)
        if (dir && data.dir && !sameDir(data.dir, dir)) setMsg(HOST_STALE_TIP)
      })
      .catch(() => {})
  }, [call, settings.libraryDir, settings.imageLimit])
  const refreshWorkflows = useCallback(() => {
    call('/workflows').then((data) => {
      setSavedWorkflows(data.items ?? [])
      setWorkflowInfo({ source: data.source ?? '', warning: data.warning ?? '' })
    }).catch((error) => setMsg('工作流列表加载失败：' + error.message))
  }, [call])
  // DSH 模型库：拉一次，用户没手动选过时自动采用当前会话模型作为默认。
  const refreshLlmModels = useCallback(() => {
    call('/llm-models').then((data) => {
      const catalog = {
        groups: data.groups ?? [],
        default: data.default ?? { provider: '', model: '' },
        warning: data.warning ?? '',
      }
      setLlmCatalog(catalog)
      setSettings((prev) => {
        if (prev.llmSelection) return prev
        const auto = selectionValue(catalog.default.provider, catalog.default.model)
        if (!auto) return prev
        const next = { ...prev, llmSelection: auto }
        writeSettings(next)
        return next
      })
    }).catch(() => {})
  }, [call])

  useEffect(() => {
    refreshStatus()
    refreshModels()
    refreshHistory()
    refreshLibrary()
    refreshWorkflows()
    refreshLlmModels()
  }, [refreshStatus, refreshModels, refreshHistory, refreshLibrary, refreshWorkflows, refreshLlmModels])

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshStatus()
      if (tab === 'generate') refreshHistory()
      if (promptId) {
        call('/progress?promptId=' + encodeURIComponent(promptId)).then(setProgress).catch(() => {})
      }
    }, 4000)
    return () => window.clearInterval(timer)
  }, [tab, promptId, call, refreshStatus, refreshHistory])

  const updateParam = (key) => (event) => setParams((prev) => ({ ...prev, [key]: event.target.value }))
  const updateSetting = (key) => (event) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: event.target.value }
      writeSettings(next)
      return next
    })
  }

  const results = useMemo(() => {
    if (!promptId) return []
    const run = history.find((item) => item.id === promptId)
    return run?.images ?? (progress?.outputs ?? [])
  }, [promptId, history, progress])

  const doGenerate = async () => {
    setBusy(true)
    setMsg('')
    try {
      const data = await call('/run', {
        method: 'POST',
        body: {
          prompt: workflow?.prompt,
          params,
          overrides,
        },
      })
      setPromptId(data.promptId)
      setMsg(data.warnings?.length ? '已提交：' + data.warnings.join('；') : '已提交到 ComfyUI')
      window.setTimeout(() => { refreshHistory(); refreshStatus() }, 800)
    } catch (error) {
      setMsg('生成失败：' + error.message)
    } finally {
      setBusy(false)
    }
  }

  const doInterrupt = async () => {
    try { await call('/interrupt', { method: 'POST' }); setMsg('已发送中断请求') } catch (error) { setMsg(error.message) }
  }
  const doClearQueue = async () => {
    try { await call('/clear-queue', { method: 'POST' }); refreshStatus(); setMsg('已清空等待队列') } catch (error) { setMsg(error.message) }
  }

  const doAiPrompt = async () => {
    if (aiIdea.trim() === '') { setMsg('先写一句你想要的画面'); return }
    setAiBusy(true)
    setMsg('')
    try {
      const [provider, model] = String(settings.llmSelection ?? '').split('|')
      const data = await call('/prompt-assist', {
        method: 'POST',
        body: {
          idea: aiIdea,
          positive: params.positive,
          negative: params.negative,
          checkpoint: params.checkpoint,
          provider: provider || undefined,
          model: model || undefined,
        },
      })
      setParams((prev) => ({ ...prev, positive: data.prompt }))
      setMsg('AI 提示词已写入正向提示词框，可继续手动修改')
    } catch (error) {
      setMsg('AI 写提示词失败：' + error.message)
    } finally {
      setAiBusy(false)
    }
  }

  const onWorkflowSelect = async (name, options) => {
    const quiet = options?.quiet === true
    setSelectedWorkflow(name)
    setSettings((prev) => {
      const next = { ...prev, selectedWorkflow: name }
      writeSettings(next)
      return next
    })
    if (!name) {
      setWorkflow(null)
      setWorkflowName('')
      setOverrides({})
      setSelectedNode('')
      setSyncRevision('')
      setCanvasKey('')
      setMsg('已切换到内置文生图模板')
      return
    }
    if (!quiet) setMsg('')
    try {
      const data = await call('/workflow-file?name=' + encodeURIComponent(name))
      setWorkflow({
        prompt: data.prompt, mapping: data.mapping, canvas: data.canvas,
        document: data.document, path: data.path, revision: data.revision,
      })
      setWorkflowName(data.name ?? name)
      setSelectedNode('')
      setParams((prev) => mergeWorkflowParams(prev, data.params))
      setOverrides({})
      setSyncRevision(data.revision ?? '')
      setCanvasKey((data.name ?? name) + ':' + (data.revision ?? ''))
      if (!quiet) setMsg(`已识别并载入 ${data.name ?? name}，共 ${data.mapping?.nodes?.length ?? 0} 个节点`)
    } catch (error) {
      setMsg('载入工作流失败：' + error.message)
    }
  }

  // 探测 ComfyUI 桥接扩展：装了才能把画布改动实时推到 ComfyUI 画布。
  useEffect(() => {
    call('/bridge-status').then((data) => {
      setBridgeState({ installed: data.installed === true, version: data.version ?? '' })
    }).catch(() => {})
  }, [call])

  const syncEnabled = settings.syncCanvas !== '0'
  const syncLabel = !workflow?.path ? null
    : !syncEnabled ? { ok: false, text: '同步已关闭' }
      : bridgeState.installed ? { ok: true, text: '与 Comfy 同步中' }
        : { ok: false, text: '桥接未装 · 仅存磁盘' }

  const applyCanvasChange = async (edit, nextCanvas) => {
    if (!workflow?.path || !selectedWorkflow) { setMsg('手动载入的工作流没有磁盘路径，无法写回'); return }
    setWorkflow((prev) => (prev ? { ...prev, canvas: nextCanvas } : prev))
    try {
      const data = await call('/workflow-apply', {
        method: 'POST',
        body: { name: selectedWorkflow, edit, sync: syncEnabled },
      })
      setSyncRevision(data.revision ?? '')
      setWorkflow((prev) => (prev ? { ...prev, prompt: data.prompt, mapping: data.mapping, revision: data.revision } : prev))
      setParams((prev) => mergeWorkflowParams(prev, data.params))
      if (data.push?.ok === false) setBridgeState({ installed: false, version: '' })
      setMsg(data.push?.ok === false
        ? '已写回工作流文件；ComfyUI 未装桥接，重启 ComfyUI 后可实时同步'
        : '已写回并同步到 ComfyUI')
    } catch (error) {
      setMsg('写回工作流失败：' + error.message)
    }
  }

  const onNodeMove = (nodeId, x, y) => {
    if (!workflow?.canvas) return
    const nextCanvas = {
      ...workflow.canvas,
      nodes: workflow.canvas.nodes.map((node) => (
        String(node.id) === String(nodeId) ? { ...node, pos: [x, y] } : node
      )),
    }
    void applyCanvasChange({ op: 'move', id: nodeId, x, y }, nextCanvas)
  }

  const onWidgetChange = (nodeId, index, value) => {
    if (!workflow?.canvas) return
    const nextCanvas = {
      ...workflow.canvas,
      nodes: workflow.canvas.nodes.map((node) => {
        if (String(node.id) !== String(nodeId)) return node
        return { ...node, widgets: (node.widgets ?? []).map((widget, i) => (i === Number(index) ? { ...widget, value } : widget)) }
      }),
    }
    void applyCanvasChange({ op: 'widget', id: nodeId, index, value }, nextCanvas)
  }

  const onCanvasDelete = async (ids) => {
    if (!workflow?.document || !selectedWorkflow) { setMsg('手动载入的工作流没有磁盘路径，无法删除节点'); return }
    const removed = new Set(ids.map(String))
    const document = {
      ...workflow.document,
      nodes: (workflow.document.nodes ?? []).filter((node) => !removed.has(String(node.id))),
      links: (workflow.document.links ?? []).filter((link) => !removed.has(String(link[1])) && !removed.has(String(link[3]))),
    }
    try {
      const data = await call('/workflow-save', {
        method: 'POST', body: { name: selectedWorkflow, document, sync: syncEnabled },
      })
      setSyncRevision(data.revision ?? '')
      setWorkflow((prev) => (prev ? { ...prev, document, revision: data.revision } : prev))
      setCanvasKey(selectedWorkflow + ':local:' + (data.revision ?? ''))
      setMsg(`已删除 ${ids.length} 个节点并同步到 ComfyUI`)
    } catch (error) {
      setMsg('删除节点失败：' + error.message)
    }
  }

  // ComfyUI 里点「保存工作流」会写磁盘，这里轮询版本号自动把改动刷新到 DSH 画布。
  useEffect(() => {
    if (!workflow?.path || !selectedWorkflow || !syncEnabled || !syncRevision) return
    const timer = window.setInterval(async () => {
      try {
        const data = await call('/workflow-revision?name=' + encodeURIComponent(selectedWorkflow))
        if (data.revision && data.revision !== syncRevision) {
          await onWorkflowSelect(selectedWorkflow, { quiet: true })
          setMsg('已同步 ComfyUI 保存的更改')
        }
      } catch (error) { /* 轮询失败不打扰用户 */ }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [workflow?.path, selectedWorkflow, syncEnabled, syncRevision, call, onWorkflowSelect])

  // 工作流列表就绪后自动恢复上次选择（只恢复一次）。
  useEffect(() => {
    if (restoredRef.current || savedWorkflows.length === 0) return
    restoredRef.current = true
    const remembered = String(settings.selectedWorkflow ?? '')
    if (remembered && savedWorkflows.some((item) => item.name === remembered)) {
      onWorkflowSelect(remembered)
    }
  }, [savedWorkflows, settings.selectedWorkflow])

  const clearWorkflow = () => {
    setWorkflow(null)
    setOverrides({})
    setWorkflowName('')
    setSelectedWorkflow('')
    setSelectedNode('')
    setSyncRevision('')
    setCanvasKey('')
    setMsg('')
    setSettings((prev) => {
      const next = { ...prev, selectedWorkflow: '' }
      writeSettings(next)
      return next
    })
  }

  const onWorkflowFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setMsg('')
    try {
      const document = JSON.parse(await file.text())
      const data = await call('/parse-workflow', { method: 'POST', body: { document } })
      setWorkflow({ prompt: data.prompt, mapping: data.mapping, canvas: data.canvas })
      setWorkflowName(file.name)
      setSelectedNode('')
      setSelectedWorkflow('')
      setSettings((prev) => {
        const next = { ...prev, selectedWorkflow: '' }
        writeSettings(next)
        return next
      })
      setParams((prev) => mergeWorkflowParams(prev, data.params))
      setOverrides({})
      setTab('workflow')
      setMsg(`已载入 ${file.name}，共 ${data.mapping?.nodes?.length ?? 0} 个节点`)
    } catch (error) {
      setMsg('载入工作流失败：' + error.message)
    }
    event.target.value = ''
  }

  const onUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setMsg('')
    try {
      const form = new FormData()
      form.append('image', file)
      const response = await fetch(withBase('/api/dsh-comfyui-desk/upload', settings.base), { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok || data.ok === false) throw new Error(data.error ?? ('HTTP ' + response.status))
      setOverrides((prev) => {
        const imageNode = workflow?.mapping?.slots?.loadImage
        const key = imageNode ? imageNode + '.image' : 'image'
        return { ...prev, [key]: data.name }
      })
      setMsg('图片已上传到 ComfyUI：' + data.name + (workflow?.mapping?.slots?.loadImage ? '，已填入 LoadImage 节点' : '；载入含 LoadImage 的工作流后可在节点映射里填写'))
    } catch (error) {
      setMsg('上传失败：' + error.message)
    }
    event.target.value = ''
  }

  const doSaveImage = async (image) => {
    try {
      const dir = String(settings.libraryDir ?? '').trim()
      await call('/save-image', {
        method: 'POST',
        body: { filename: image.filename, subfolder: image.subfolder, type: image.type, dir },
      })
      refreshLibrary()
      setMsg('已存入图片库：' + image.filename)
    } catch (error) {
      setMsg('保存失败：' + error.message)
    }
  }

  // 图库目录：写入本地设置并立即重新扫描；留空回退 Host 默认目录。
  // 输入框是用户草稿，应用时把它同步为已生效值；刷新过程不会覆盖它。
  const applyLibraryDir = (dir) => {
    const value = String(dir ?? '').trim()
    setSettings((prev) => {
      const next = { ...prev, libraryDir: value }
      writeSettings(next)
      return next
    })
    setLibraryDirInput(value)
    setSelectedImages([])
    setMsg(value ? '图片库目录已切换：' + value : '已恢复默认图片库目录')
    call('/images?limit=' + encodeURIComponent(String(settings.imageLimit ?? '0')) + (value ? '&dir=' + encodeURIComponent(value) : ''))
      .then((data) => {
        setLibrary(data.images ?? [])
        setLibraryActiveDir(data.dir ?? value)
        // Host 若还是旧版，会忽略 dir 参数并返回默认目录——明确提示重启，避免误以为"换不了"。
        if (value && data.dir && !sameDir(data.dir, value)) setMsg(HOST_STALE_TIP)
      })
      .catch((error) => setMsg('读取目录失败：' + error.message))
  }

  const openLibraryFolder = async () => {
    try {
      const data = await call('/library-open', {
        method: 'POST',
        body: { dir: String(settings.libraryDir ?? '').trim() },
      })
      setMsg('已打开文件夹：' + (data.path ?? ''))
    } catch (error) {
      // 404 / "不是 JSON" = 新路由 /library-open 还没加载，基本都是 Host 没重启。
      if (/404|不是 JSON|连不上/.test(error.message)) setMsg('打开文件夹失败：' + HOST_STALE_TIP)
      else setMsg('打开文件夹失败：' + error.message)
    }
  }

  const toggleImage = (name) => setSelectedImages((prev) => (
    prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]
  ))

  const deleteImageByName = async (name) => {
    if (!window.confirm('确定删除图片「' + name + '」？此操作不可撤销。')) return
    try {
      const dir = String(settings.libraryDir ?? '').trim()
      await call('/library-file?name=' + encodeURIComponent(name) + (dir ? '&dir=' + encodeURIComponent(dir) : ''), { method: 'DELETE' })
      setSelectedImages((prev) => prev.filter((item) => item !== name))
      setLightbox(null)
      setMsg('已删除：' + name)
      refreshLibrary()
    } catch (error) {
      setMsg('删除失败：' + error.message)
    }
  }

  const deleteSelected = async () => {
    if (selectedImages.length === 0) { setMsg('请先勾选要删除的图片'); return }
    if (!window.confirm('确定删除选中的 ' + selectedImages.length + ' 张图片？此操作不可撤销。')) return
    const dir = String(settings.libraryDir ?? '').trim()
    let removed = 0
    for (const name of selectedImages) {
      try {
        await call('/library-file?name=' + encodeURIComponent(name) + (dir ? '&dir=' + encodeURIComponent(dir) : ''), { method: 'DELETE' })
        removed += 1
      } catch (error) { setMsg('删除「' + name + '」失败：' + error.message) }
    }
    setSelectedImages([])
    setMsg('已删除 ' + removed + ' 张图片')
    refreshLibrary()
  }

  const outputUrl = (image) => withBase('/api/dsh-comfyui-desk/view?filename=' + encodeURIComponent(image.filename)
    + '&subfolder=' + encodeURIComponent(image.subfolder ?? '') + '&type=' + encodeURIComponent(image.type ?? 'output'), settings.base)
  const libraryDirQuery = String(settings.libraryDir ?? '').trim() ? '&dir=' + encodeURIComponent(settings.libraryDir.trim()) : ''
  const libraryUrl = (image) => withBase('/api/dsh-comfyui-desk/library-file?name=' + encodeURIComponent(image.name) + libraryDirQuery, settings.base)
  const openResults = (index) => setLightbox({ kind: 'results', index })
  const openLibrary = (index) => setLightbox({ kind: 'library', index })
  const lightboxItems = lightbox?.kind === 'results' ? results : library
  const lightboxUrl = lightbox?.kind === 'results' ? outputUrl : libraryUrl

  return h('div', { className: 'ccd' },
    h('style', null, STYLE),
    h('div', { className: 'ccd-head' },
      h('span', { className: 'ccd-title' }, 'ComfyUI 工作台'),
      h('button', {
        className: 'ccd-btn', onClick: () => { refreshStatus(); refreshModels(); refreshHistory(); refreshLibrary() },
      }, '刷新'),
      h('button', { className: 'ccd-btn', onClick: () => setShowSettings((value) => !value) }, '设置')),
    h('div', { className: 'ccd-tabs' },
      ['generate', 'workflow', 'library'].map((key) => h('button', {
        key,
        className: 'ccd-tab' + (tab === key ? ' on' : ''),
        onClick: () => setTab(key),
      }, key === 'generate' ? '生成' : key === 'workflow' ? '工作流' : '图片库'))),
    h('div', { className: 'ccd-body' + (tab === 'library' ? ' ccd-body-fixed' : '') },
      showSettings ? h('div', { className: 'ccd-card' },
        h('h4', null, '连接与 AI 设置'),
        h('div', { className: 'ccd-row' }, h('label', null, 'ComfyUI'),
          h('input', { className: 'ccd-field', value: settings.base, onChange: updateSetting('base'), placeholder: 'http://127.0.0.1:8188' })),
        h('div', { className: 'ccd-row' }, h('label', null, 'AI 模型'),
          h('select', { className: 'ccd-select', value: settings.llmSelection ?? '', onChange: updateSetting('llmSelection') },
            h('option', { value: '' }, '跟随 DSH 当前会话模型'),
            (llmCatalog.groups ?? []).map((group) => h('optgroup', { key: group.provider, label: group.name || group.provider },
              (group.models ?? []).map((model) => h('option', {
                key: group.provider + '|' + model.id,
                value: selectionValue(group.provider, model.id),
              }, model.name || model.id))))),
          h('button', { className: 'ccd-btn', onClick: refreshLlmModels }, '刷新模型库')),
        h('div', { className: 'ccd-hint' },
          llmCatalog.warning
            ? 'DSH 模型库：' + llmCatalog.warning
            : '模型来自 DSH 已配置的模型库（'
              + (llmCatalog.groups ?? []).reduce((sum, group) => sum + (group.models?.length ?? 0), 0)
              + ' 个），默认使用 DSH 当前会话模型。设置保存在浏览器本地。'),
        h('div', { className: 'ccd-row' }, h('label', null, '画布同步'),
          h('select', {
            className: 'ccd-select', value: settings.syncCanvas ?? '1',
            onChange: updateSetting('syncCanvas'),
          },
            h('option', { value: '1' }, '开启：改节点/控件同步到 ComfyUI'),
            h('option', { value: '0' }, '关闭：只在 DSH 面板内修改')),
          h('button', {
            className: 'ccd-btn',
            onClick: () => call('/bridge-status').then((data) => {
              setBridgeState({ installed: data.installed === true, version: data.version ?? '' })
              setMsg(data.installed ? 'ComfyUI 桥接已就绪' : 'ComfyUI 桥接未生效：请重启 ComfyUI 加载新插件')
            }).catch((error) => setMsg(error.message)),
          }, '检测桥接')),
        h('div', { className: 'ccd-hint' },
          '桥接扩展位于 ComfyUI 的 custom_nodes/dsh_desk_bridge，重启 ComfyUI 后生效；ComfyUI 里保存工作流会自动同步回 DSH。')) : null,

      tab === 'generate' ? h('div', null,
        h(StatusCards, { status, error: msg }),
        h('div', { className: 'ccd-card', style: { marginTop: 10 } },
          h('h4', null, '提示词'),
          h('textarea', {
            className: 'ccd-area', value: params.positive, onChange: updateParam('positive'),
            placeholder: '正向提示词：主体、外观、环境、光线、镜头、风格……',
          }),
          h('div', { className: 'ccd-row' },
            h('input', {
              className: 'ccd-field', value: aiIdea, onChange: (event) => setAiIdea(event.target.value),
              placeholder: '用中文描述你想要的画面，点「AI 写提示词」',
            }),
            h('button', { className: 'ccd-btn', onClick: doAiPrompt, disabled: aiBusy }, aiBusy ? '写…' : 'AI 写提示词')),
          h('textarea', {
            className: 'ccd-area', value: params.negative, onChange: updateParam('negative'),
            placeholder: '负向提示词：低质量、模糊、多余肢体……',
          })),
        h('div', { className: 'ccd-card' },
          h('h4', null, '生成参数'),
          h('div', { className: 'ccd-row' }, h('label', null, '工作流'),
            h('select', {
              className: 'ccd-select', value: selectedWorkflow,
              onChange: (event) => onWorkflowSelect(event.target.value),
            },
            h('option', { value: '' }, '（内置文生图模板）'),
            savedWorkflows.map((item) => h('option', {
              key: item.path || item.name, value: item.name,
            }, `${item.name} · ${item.nodeCount} 节点`)))),
          h('div', { className: 'ccd-hint' },
            workflowName
              ? `当前工作流：${workflowName}${params.checkpoint ? ' · 模型 ' + short(params.checkpoint, 28) : ''}`
              : '切换工作流只更新模型、尺寸等参数；已输入的提示词与随机种子保持不变。'),
          h('div', { className: 'ccd-grid2' },
            h('div', { className: 'ccd-row' }, h('label', null, '宽'), h('input', { className: 'ccd-field', type: 'number', value: params.width, onChange: updateParam('width') })),
            h('div', { className: 'ccd-row' }, h('label', null, '高'), h('input', { className: 'ccd-field', type: 'number', value: params.height, onChange: updateParam('height') }))),
          h('div', { className: 'ccd-grid2' },
            h('div', { className: 'ccd-row' }, h('label', null, '步数'), h('input', { className: 'ccd-field', type: 'number', value: params.steps, onChange: updateParam('steps') })),
            h('div', { className: 'ccd-row' }, h('label', null, 'CFG'), h('input', { className: 'ccd-field', type: 'number', step: '0.1', value: params.cfg, onChange: updateParam('cfg') }))),
          h('div', { className: 'ccd-grid2' },
            h('div', { className: 'ccd-row' },
              h('label', null, '种子'),
              h('input', {
                className: 'ccd-field', type: 'number', value: params.seed, placeholder: '-1 = 每次随机',
                title: '-1 或留空表示每次生成随机', onChange: updateParam('seed'),
              }),
              h('button', {
                className: 'ccd-btn', title: '恢复每次生成随机种子',
                onClick: () => setParams((prev) => ({ ...prev, seed: -1 })),
              }, '随机')),
            h('div', { className: 'ccd-row' }, h('label', null, '批次'), h('input', { className: 'ccd-field', type: 'number', value: params.batch, onChange: updateParam('batch') }))),
          h('div', { className: 'ccd-actions' },
            h('button', { className: 'ccd-btn primary', onClick: doGenerate, disabled: busy }, busy ? '提交中…' : '生成'),
            h('button', { className: 'ccd-btn', onClick: doInterrupt }, '中断'),
            h('button', { className: 'ccd-btn', onClick: doClearQueue }, '清空队列'),
            h('button', { className: 'ccd-btn', onClick: () => uploadRef.current?.click() }, '上传输入图')),
          h('input', { ref: uploadRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: onUpload })),
        progress && promptId ? h('div', { className: 'ccd-card' },
          h(Meter, {
            label: progress.failed ? '生成失败' : progress.completed ? '生成完成' : '生成进度',
            value: progress.percent ?? 0,
            max: 100,
            tone: progress.failed ? 'bad' : progress.completed ? 'ok' : undefined,
            detail: '节点 ' + (progress.node || '—')
              + (Number(progress.max) > 0 ? ' · 步 ' + (progress.value ?? 0) + '/' + progress.max : ''),
          })) : null,
        h('div', { className: 'ccd-card' },
          h('h4', null, '本次生成'),
          h(ImageGrid, { images: results, urlOf: outputUrl, onOpen: openResults, onSave: doSaveImage })),
        h('div', { className: 'ccd-card' },
          h('h4', null, '最近生成'),
          h(ImageGrid, {
            images: history.flatMap((run) => (run.images ?? []).map((image) => ({ ...image, id: run.id }))),
            urlOf: outputUrl,
            onOpen: (index) => {
              const all = history.flatMap((run) => run.images ?? [])
              setPromptId(all[index]?.id ?? '')
              setLightbox({ kind: 'results', index })
            },
          })),
        h('div', { className: 'ccd-msg' }, msg)) : null,

      tab === 'workflow' ? h('div', null,
        h('div', { className: 'ccd-card' },
          h('h4', null, '工作流（自动识别本机已保存的工作流）'),
          h('div', { className: 'ccd-row' }, h('label', null, '已保存'),
            h('select', {
              className: 'ccd-select', value: selectedWorkflow,
              onChange: (event) => onWorkflowSelect(event.target.value),
            },
            h('option', { value: '' }, `（选择工作流，共 ${savedWorkflows.length} 个）`),
            savedWorkflows.map((item) => h('option', {
              key: item.path || item.name, value: item.name,
            }, `${item.name} · ${item.nodeCount} 节点`)))),
          h('div', { className: 'ccd-hint' },
            workflowInfo.warning || (workflowInfo.source === 'disk'
              ? `已自动扫描到 ${savedWorkflows.length} 个工作流（本机磁盘）`
              : workflowInfo.source === 'api' ? '来自 ComfyUI 接口；磁盘路径不可读，只能手动载入 JSON' : '正在扫描工作流…')),
          h('div', { className: 'ccd-actions' },
            h('button', { className: 'ccd-btn', onClick: refreshWorkflows }, '重新扫描'),
            h('button', { className: 'ccd-btn', onClick: () => fileRef.current?.click() }, '载入其它 JSON'),
            workflow ? h('button', { className: 'ccd-btn', onClick: clearWorkflow }, '清除工作流') : null),
          h('input', { ref: fileRef, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: onWorkflowFile }),
          h('div', { className: 'ccd-hint' }, workflow ? `当前：${workflowName} · ${workflow.mapping?.nodes?.length ?? 0} 个节点，参数已自动回填到「生成」页` : '未载入工作流时，「生成」使用内置文生图模板。')),
        workflow && (workflow.canvas?.nodes?.length ?? 0) > 0 ? h('div', { className: 'ccd-card' },
          h('h4', null, '工作流图'),
          h(WorkflowCanvas, {
            canvas: workflow.canvas, selectedId: selectedNode, onSelect: setSelectedNode,
            resetKey: canvasKey, onNodeMove, onWidgetChange, onDelete: onCanvasDelete, syncLabel,
          }),
          h('div', { className: 'ccd-hint' },
            `${workflow.canvas.nodes.length} 个节点 · ${workflow.canvas.links?.length ?? 0} 条连线；`
            + '滚轮缩放（以鼠标为中心）、右键/中键或 Shift+拖拽平移、拖节点标题栏移动、框选后 Delete 删除、节点内输入框改控件后回车写入；'
            + '改动会写回工作流文件并实时同步到 ComfyUI。')) : null,
        workflow ? h('div', { className: 'ccd-card' },
          h('h4', null, '节点映射（可直接改输入值）'),
          (workflow.mapping?.nodes ?? []).map((node) => h('div', { className: 'ccd-node', key: node.id,
            style: String(node.id) === String(selectedNode) ? { outline: '2px solid var(--ccd-accent)' } : undefined },
            h('div', { className: 'hd' },
              h('span', { className: 'id' }, '#' + node.id),
              h('span', { className: 'type' }, node.title),
              h('span', { className: 'id' }, node.classType)),
            node.inputs.map((input) => {
              const key = node.id + '.' + input.name
              return h('div', { className: 'ccd-input', key: key },
                h('span', { className: 'nm', title: input.name }, input.name),
                input.source
                  ? h('span', { className: 'src' }, '← 节点 ' + input.source.node + '[' + input.source.slot + ']')
                  : h('input', {
                    value: overrides[key] !== undefined ? overrides[key] : (input.value ?? ''),
                    onChange: (event) => setOverrides((prev) => ({ ...prev, [key]: event.target.value })),
                  }))
            }))),
          h('div', { className: 'ccd-actions' },
            h('button', { className: 'ccd-btn primary', onClick: doGenerate, disabled: busy }, '按此工作流生成'),
            h('button', { className: 'ccd-btn', onClick: () => setOverrides({}) }, '重置修改'))) : null,
        h('div', { className: 'ccd-msg' }, msg)) : null,

      tab === 'library' ? h('div', { className: 'ccd-library' },
        h('div', { className: 'ccd-library-fixed' },
          h('div', { className: 'ccd-card' },
            h('h4', null, '图片库'),
            h('div', { className: 'ccd-hint' },
              '指定一个文件夹，直接显示里面的图片；显示张数可调，默认全部。可删除、打开文件夹。生成页点图片右上角「存」可把 ComfyUI 输出复制进来。'),
            h('div', { className: 'ccd-row' },
              h('label', null, '文件夹'),
              h('input', {
                className: 'ccd-field', value: libraryDirInput,
                onChange: (event) => setLibraryDirInput(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') applyLibraryDir(libraryDirInput) },
                placeholder: '留空 = 默认 ~/Pictures/DSH-ComfyUI',
              })),
            h('div', { className: 'ccd-row' }, h('label', null, '显示'),
              h('select', { className: 'ccd-select', value: String(settings.imageLimit ?? '0'), onChange: updateSetting('imageLimit') },
                h('option', { value: '0' }, '全部（不限张数）'),
                h('option', { value: '200' }, '最多 200 张'),
                h('option', { value: '60' }, '最多 60 张')),
              h('span', { className: 'ccd-hint', style: { marginTop: 0 } }, '改这里立即重载')),
            h('div', { className: 'ccd-path' },
              h('span', null, '当前：'),
              h('code', { title: libraryActiveDir }, libraryActiveDir || '（读取中）')),
            h('div', { className: 'ccd-actions' },
              h('button', { className: 'ccd-btn primary', onClick: () => applyLibraryDir(libraryDirInput) }, '应用目录'),
              h('button', { className: 'ccd-btn', onClick: () => folderRef.current?.click() }, '浏览…'),
              h('button', { className: 'ccd-btn', onClick: openLibraryFolder }, '打开文件夹'),
              h('button', { className: 'ccd-btn', onClick: refreshLibrary }, '刷新列表'),
              h('button', { className: 'ccd-btn', onClick: () => applyLibraryDir('') }, '恢复默认')),
            h('input', {
              ref: folderRef, type: 'file', style: { display: 'none' },
              // 浏览器目录选择：取所选文件的父目录作为图库目录。
              webkitdirectory: '', directory: '',
              onChange: (event) => {
                const file = event.target.files?.[0]
                const relative = String(file?.webkitRelativePath ?? '')
                const full = String(file?.path ?? '')
                if (relative && full) {
                  // file.path 是绝对路径，webkitRelativePath 是相对所选目录根的路径；
                  // 去掉尾部相对部分即可得到用户选中的文件夹。
                  const normalized = full.replace(/\\/g, '/')
                  const suffix = relative.replace(/\\/g, '/')
                  const root = normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length).replace(/\/$/, '') : ''
                  if (root) applyLibraryDir(root)
                  else setMsg('无法从选择中推导目录，请直接粘贴路径')
                } else {
                  setMsg('当前环境不支持目录选择，请直接把文件夹路径粘贴到输入框')
                }
                event.target.value = ''
              },
            })),
          h('div', { className: 'ccd-msg' }, msg)),
        h('div', { className: 'ccd-library-scroll' },
          h('div', { className: 'ccd-card' },
            h('div', { className: 'ccd-actions', style: { marginTop: 0 } },
              h('button', {
                className: 'ccd-btn',
                onClick: () => { setSelectMode((value) => !value); setSelectedImages([]) },
              }, selectMode ? '退出多选' : '多选删除'),
              selectMode ? h('button', { className: 'ccd-btn primary', onClick: deleteSelected }, '删除选中（' + selectedImages.length + '）') : null,
              h('span', { className: 'ccd-hint', style: { marginTop: 0 } }, '共 ' + library.length + ' 张')),
            h(ImageGrid, {
              images: library, urlOf: libraryUrl,
              onOpen: openLibrary,
              selectable: selectMode, selected: selectedImages, onToggle: toggleImage,
              onDelete: selectMode ? undefined : (image) => deleteImageByName(image.name),
            })))) : null),
    lightboxItems && lightbox ? h(Lightbox, {
      items: lightboxItems,
      index: lightbox.index,
      urlOf: lightboxUrl,
      onClose: () => setLightbox(null),
      onIndex: (index) => setLightbox({ ...lightbox, index }),
    }) : null)
}

function SidebarIcon(props) {
  const size = typeof props?.size === 'number' ? props.size : 18
  const active = props?.active === true
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
    style: { display: 'block', flex: 'none' },
  },
  h('rect', { x: 3, y: 4.6, width: 7, height: 5.4, rx: 1.7, stroke: 'currentColor', strokeWidth: 1.5, opacity: active ? 1 : 0.8 }),
  h('rect', { x: 13.6, y: 14, width: 7, height: 5.4, rx: 1.7, stroke: 'currentColor', strokeWidth: 1.5, opacity: active ? 1 : 0.8 }),
  h('path', { d: 'M10.2 7.3h2.2a2 2 0 0 1 2 2v4.7', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', opacity: 0.6 }),
  h('circle', { cx: 17.6, cy: 4.6, r: 2.4, fill: 'currentColor', opacity: active ? 1 : 0.6 }))
}

module.exports = {
  name: PKG + '-client',
  inject: ['slots'],
  apply(ctx) {
    try {
      const slots = serviceOf(ctx, 'slots')
      if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
        try { console.warn('[dsh-comfyui-desk] slots service unavailable') } catch (inner) { /* ignore */ }
        return
      }
      const disposers = [
        slots.inject('main', () => slots.register({
          name: 'main',
          key: TAB_ID,
        }, ComfyDeskPanel)),
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: TAB_ID,
          order: 32,
          label: () => 'ComfyUI 工作台',
        }, SidebarIcon)),
      ]
      const effect = typeof ctx?.effect === 'function'
        ? (callback, label) => ctx.effect(callback, label)
        : (callback) => callback()
      effect(() => () => {
        for (const dispose of disposers.reverse()) {
          try { dispose() } catch (inner) { /* ignore */ }
        }
      }, NS + ': panel')
    } catch (error) {
      try { console.error('[dsh-comfyui-desk] client apply failed:', error) } catch (inner) { /* ignore */ }
    }
  },
}
