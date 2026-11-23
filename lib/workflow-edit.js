/** 对 ComfyUI 原始画布文档做单点编辑，用于 DSH 画布操作写回。 */

function numeric(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function coerceWidget(value, previous) {
  if (typeof previous === 'number') return numeric(value, previous)
  if (typeof previous === 'boolean') return String(value).toLowerCase() === 'true' || value === '1' || value === true
  return value
}

function findNode(document, id) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const node = nodes.find((item) => String(item?.id) === String(id))
  if (!node) throw new Error(`工作流里找不到节点 ${id}`)
  return node
}

/**
 * 支持的操作：
 *   move   { id, x, y }              拖动节点
 *   widget { id, index, value }      改节点控件值
 */
export function applyCanvasEdit(document, edit) {
  const op = String(edit?.op ?? '')
  if (op === 'move') {
    const node = findNode(document, edit.id)
    const pos = Array.isArray(node.pos) ? node.pos : [0, 0]
    node.pos = [numeric(edit.x, pos[0]), numeric(edit.y, pos[1])]
    return document
  }
  if (op === 'widget') {
    const node = findNode(document, edit.id)
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : []
    const index = Math.trunc(numeric(edit.index, -1))
    if (index < 0 || index >= values.length) throw new Error(`节点 ${edit.id} 没有第 ${index + 1} 个控件`)
    values[index] = coerceWidget(edit.value, values[index])
    node.widgets_values = values
    return document
  }
  throw new Error('未知的画布操作：' + op)
}
