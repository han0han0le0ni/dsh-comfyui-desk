// DSH ComfyUI Desk → ComfyUI 画布实时同步。
// DSH 面板改节点位置/控件值后，经后端 websocket 广播到这里，本扩展即时应用。

import { app } from "../../scripts/app.js"
import { api } from "../../scripts/api.js"

const TAG = "[dsh_desk_bridge]"

function applyEdit(detail) {
  const op = String(detail?.op ?? "")
  const graph = app.graph

  if (op === "move") {
    const node = graph?.getNodeById(Number(detail.id))
    if (!node) return
    node.pos = [Number(detail.x) || 0, Number(detail.y) || 0]
    graph.setDirtyCanvas?.(true, true)
    return
  }

  if (op === "widget") {
    const node = graph?.getNodeById(Number(detail.id))
    const index = Number(detail.index)
    const widget = node?.widgets?.[index]
    if (!widget) return
    widget.value = detail.value
    if (typeof widget.callback === "function") {
      try { widget.callback(detail.value) } catch (e) { console.warn(TAG, "widget callback", e) }
    }
    node.setDirtyCanvas?.(true, true)
    graph.setDirtyCanvas?.(true, true)
    return
  }

  if (op === "load" && detail.graph && typeof app.loadGraphData === "function") {
    const result = app.loadGraphData(detail.graph, false, true)
    if (result && typeof result.catch === "function") result.catch((e) => console.warn(TAG, "loadGraphData", e))
  }
}

api.addEventListener("dsh_desk_apply", (event) => {
  try {
    applyEdit(event.detail)
  } catch (error) {
    console.warn(TAG, "应用 DSH 画布同步失败", error)
  }
})

console.info(TAG, "已加载，DSH 画布同步就绪")
