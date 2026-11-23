"""DSH ComfyUI Desk 画布同步桥接。

DSH 侧面板改节点位置 / 控件值后，调用本插件的 /dsh_desk_bridge/apply，
本插件通过 ComfyUI websocket 广播给所有已打开的 ComfyUI 页面，前端即时应用。

反向同步不需要本插件参与：在 ComfyUI 里点「保存工作流」会写磁盘，
DSH 侧轮询文件版本号后自动刷新画布。
"""

import logging

from aiohttp import web
from server import PromptServer

VERSION = "1.0.0"
log = logging.getLogger("dsh_desk_bridge")


@PromptServer.instance.routes.get("/dsh_desk_bridge/status")
async def dsh_desk_bridge_status(request):
    return web.json_response({"ok": True, "version": VERSION})


@PromptServer.instance.routes.post("/dsh_desk_bridge/apply")
async def dsh_desk_bridge_apply(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    op = str(body.get("op", ""))
    if op not in ("move", "widget", "load"):
        return web.json_response({"ok": False, "error": "未知的画布操作: " + op}, status=400)

    payload = {
        "op": op,
        "id": body.get("id"),
        "x": body.get("x"),
        "y": body.get("y"),
        "index": body.get("index"),
        "value": body.get("value"),
        "name": body.get("name", ""),
        "path": body.get("path", ""),
        "graph": body.get("graph") if op == "load" else None,
        "source": "dsh",
    }
    PromptServer.instance.send_sync("dsh_desk_apply", payload)
    log.info("[dsh_desk_bridge] 广播画布操作 %s node=%s", op, payload.get("id"))
    return web.json_response({"ok": True})


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
