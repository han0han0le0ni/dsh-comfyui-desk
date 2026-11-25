# dsh-comfyui-desk

一个 DeepSeek Harness (DSH) 插件：在 DSH 右侧栏的「ComfyUI 工作台」面板里直接操作**本机 ComfyUI**。

> 参考了 GitHub 上已成熟的 `dsh-comfyui-studio`、`dsh-comfy`、`dsh-comfyui-link` 的插件结构（Host 注册 HTTP 路由 + Client 注册侧边栏 tab + Agent 工具），但本实现为零第三方依赖的精简版。

## 功能

### 侧边栏「ComfyUI 工作台」
- **系统状态**：GPU 与 CPU 用水平进度条显示——GPU 优先显示利用率（nvidia-smi），无 N 卡或取不到时自动退回显存占用；CPU 优先显示使用率，首次采样前退回内存占用。每条下方附显卡型号、显存/内存容量；再往下是 ComfyUI 在线状态与队列（4 秒自动刷新）
- **生成**：先选**工作流**（自动列出本机已保存的工作流，选中即载入它的模型、尺寸等参数；不选则用内置文生图模板）；再调正向/负向提示词、尺寸、步数、CFG、种子、批次；提交、中断、清空队列。**换工作流不会覆盖你已经输入的提示词**；种子默认 `-1`（每次生成随机），点「随机」可随时恢复，只有手动填入非负数字才固定种子
- **实时进度**：水平进度条显示百分比、当前节点、采样步数；完成变绿、失败变红。基于 HTTP 轮询而非 WebSocket
- **图片**：本次生成 / 最近生成的缩略图、全屏预览、上一张/下一张、下载、一键存入本地图片库
- **输入图片**：上传到 ComfyUI `input` 目录，自动填进工作流的 `LoadImage` 节点
- **本地图片库**：在「图片库」页填文件夹路径（或点「浏览…」选目录）后点「应用目录」，即显示该文件夹里的图片；可放大预览、下载、**单张删除**或**多选批量删除**、一键「打开文件夹」用系统资源管理器整理；路径会记住，重开面板自动恢复。留空则用默认目录 `~/Pictures/DSH-ComfyUI`。生成页点图片右上角「存」会把 ComfyUI 输出复制到当前图库目录
- **AI 写提示词**：模型默认从 **DSH 模型库**下拉选择（按 provider 分组），默认沿用 DSH 当前会话模型；把中文想法交给它生成英文提示词并回填
- **工作流自动识别**：自动扫描本机 ComfyUI 的 `user/default/workflows` 目录，列出全部已保存工作流，选中即载入参数（提示词框为空时才回填工作流自带提示词，已有内容保持不变；种子始终按随机处理）；**上次选择会记住，重开面板自动恢复**；也支持手动载入其它 JSON
- **工作流画布**：工作流页把 ComfyUI 原生节点图画出来——节点卡片按类别着色、贝塞尔曲线连线；**滚轮以鼠标为中心缩放、右键/中键/Shift+拖拽平移、拖节点标题栏移动、框选后 Delete 删除、节点内输入框改控件值后回车写入**；点节点定位到下方映射
- **画布双向同步**：在 DSH 画布改节点位置/控件值/删节点，会写回磁盘工作流文件并**实时同步到 ComfyUI 画布**；在 ComfyUI 里点「保存工作流」后，DSH 画布会自动刷新（详见下文）
- **工作流节点映射**：查看节点/连线/输入，直接改 `节点ID.输入名` 后生成
- **设置**：ComfyUI 地址、AI 模型（DSH 模型库下拉，可选"跟随当前会话"）、画布同步开关与桥接检测；可点"刷新模型库"重新拉取，设置保存在浏览器本地

### DSH Agent 工具
`comfy_desk_status`、`comfy_desk_generate`、`comfy_desk_draw`、`comfy_desk_progress`、`comfy_desk_history`、`comfy_desk_images`、`comfy_desk_show`、`comfy_desk_prompt`、`comfy_desk_workflows`、`comfy_desk_workflow_map`。

`comfy_desk_show` 可以把本地图片库里的图片直接显示在对话里，**ComfyUI 没开也能用**；`/view` 代理在 ComfyUI 离线时也会回退到本地图片库同名文件。

- `comfy_desk_generate`：只提交任务，返回 prompt_id
- `comfy_desk_draw`：**在 DSH 对话里直接出图**——等待生成完成，把输出图登记成对话附件（模型也能看到图），并输出 `[comfy: …]` 标记；插件前端装饰器把它替换成同源图片，对话里直接显示大图，点击可全屏预览。支持一次画多张。例如：“画一只猫”、“给我画一张赛博朋克城市”、“画两只猫，一张 512×512”。

### AI 自选工作流（不需要你指定）

**不需要说工具名，也不需要说工作流名**：只要在对话里表达"想看到一张图"，AI 就会自动调用 `comfy_desk_draw`，并**自己从本机已保存的工作流里挑一个最合适的**：

- 按画面描述识别用途：普通出图 → 文生图；提到视频/放大/局部重绘/图生图/动作 → 对应工作流
- 中文描述优先选带「中文」的工作流（如 `SDXL_Illustrious_中文文生图`），英文描述选对应的非中文版本
- 按模型质量排序（SDXL > Chroma > Qwen > SD15），结果里会说明"AI 自选工作流：xxx"
- 工作流名支持容错：即使你写"SD15文生图""sd15 文生图"也能匹配到 `SD15_文生图`

只有你**明确点名**某个工作流时才需要用 `workflowName`（如"用 SD15_文生图 画只猫"）。识别到放大/重绘/视频等**需要源图**的意图时，AI 不会硬画，而是提示你在侧边栏面板载入工作流并指定图片。

`comfy_desk_generate` 只提交任务、不回传图片，适合"先排队以后再看"的场景，同样会自动选工作流。

也可以让 AI 查显卡、查工作流列表（每条带用途/模型标注）、写提示词、分析工作流。

## 环境要求

- DSH >= 0.2.2-rc.1（已在 `0.2.2-rc.5` 验证）
- Node.js >= 20（已在 `22.22.2` 验证）
- ComfyUI 监听 `127.0.0.1:8188`（已在 `0.46.0` 验证）
- 不依赖 npm 第三方包；Host 只用 Node 内置模块，Client 只用 `react`

## 安装

装完都要**完全退出 DSH（托盘图标右键退出）再重新打开**，否则客户端入口不会注册。重开后到**右侧栏**的面板页签里找「ComfyUI 工作台」。

### 方式 A：从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-comfyui-desk
```

`--profile` 填你**正在用的那个 profile 名**。DSH 桌面版常见的是 `web`（本机就是），部分安装是 `desktop`；可以先 `dsh plugin list` 或看 `harness/profiles/` 目录确认。省略 `--profile` 会走 CLI 默认 profile，可能不是你界面上正在看的那个。

### 方式 B：从本地目录安装（开发调试）

在 DSH 里打开「插件」→ 从本地目录安装，选择本仓库目录。命令行等价写法（`dsh` 换成你的 DSH CLI 路径，profile 名同上）：

```powershell
dsh plugin --profile web add "link:<本仓库绝对路径>"
```

### 方式 C：手工挂到现有 profile
1. 把本目录链接/复制到 profile 的 `node_modules/dsh-comfyui-desk`
2. 在该 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-comfyui-desk
      name: dsh-comfyui-desk
      config:
        baseUrl: http://127.0.0.1:8188
        requestTimeoutMs: 10000
        libraryDir: ''
        llmProvider: ''
        llmModel: ''
```

3. **完全退出并重新打开 DSH**（托盘图标右键退出；只刷新页面不够），到**右侧栏**的面板页签里找「ComfyUI 工作台」。

> 配置里的 `libraryDir` 是图库默认目录（留空用 `~/Pictures/DSH-ComfyUI`）；实际使用时更推荐在面板「图片库」页里指定，路径保存在浏览器本地并对当前面板立即生效。
> AI 模型优先用面板「设置」里从 **DSH 模型库**选中的项；留空则自动沿用 DSH 当前会话模型（`agentDefaultModel`）。配置里的 `llmProvider` / `llmModel` 只作为兜底，一般不用填。模型库通过 Host 路由 `/llm-models` 读取 `llm.listProviders()` + `llm.listModels()`。

## ComfyUI 画布双向同步

DSH 面板和 ComfyUI 以**同一份磁盘工作流 JSON** 为数据源，加上一个轻量桥接扩展实现实时同步：

1. **安装桥接扩展**：把本仓库的 `comfyui-bridge/dsh_desk_bridge/` 整个目录复制到你的 ComfyUI `custom_nodes/` 下，然后**完全重启 ComfyUI** 才会加载。它含 Python 路由 `__init__.py` 与前端 `web/dsh_desk_bridge.js`，无需额外依赖。不装也能用其它功能，只是画布改动不会实时反映到 ComfyUI 当前页面。
2. **DSH → ComfyUI**：在画布上拖节点、改控件值、删节点后，Host 写回 `user/default/workflows/<名称>.json`，并通过 `/dsh_desk_bridge/apply` 经 ComfyUI WebSocket 广播；ComfyUI 页面上的扩展即时应用（移动节点、改控件、整图重载）。
3. **ComfyUI → DSH**：在 ComfyUI 里改完图后点「保存工作流」（Ctrl+S）写盘；DSH 面板每 3 秒比对文件版本号，发现变化自动重载画布。
4. **开关**：面板「设置」→「画布同步」可关闭；关闭后改动只写 DSH 本地状态，不写回磁盘。点「检测桥接」可确认扩展是否已生效。桥接未生效时写回仍会进行，只是 ComfyUI 当前画布不会实时更新。

> 注意：两边同时编辑同一工作流时，后保存的一方会覆盖先保存的一方——这是共享文件的固有限制，建议一次只在一边改。

## 开发 / 自检

```bash
node tools/build-client.mjs      # 从 client.body.js 生成 client.js
node tools/build-client.mjs --check
node tools/smoke.mjs             # 无 DSH 也能跑的单元自检
node tools/dev-server.mjs 8787   # 不启动 DSH，直接调试 HTTP 接口
```

开发服务器启动后可访问：

```
http://127.0.0.1:8787/api/dsh-comfyui-desk/status
http://127.0.0.1:8787/api/dsh-comfyui-desk/models
http://127.0.0.1:8787/api/dsh-comfyui-desk/history?limit=10
```

## 安全

- 所有 HTTP 路由都会先调用 DSH 的 `connection.requestRejection(req)` 做平台准入检查：没通过返回 401/403，不会绕过 DSH 的会话鉴权
- 平台没有该服务（DSH < 0.2.3）时放行，因此 `engines.dsh` 放宽到 `>=0.1.0`，老版本也能装能用；0.2.3 及以上会自动做准入检查
- 桥接扩展只监听 ComfyUI 本地 WebSocket，只有 `/dsh_desk_bridge/status` 与 `/apply` 两个端点，不接受任意写盘指令
- 仓库内没有硬编码密钥；LLM 凭据由 DSH 模型库提供

## 已知限制

- 本机 ComfyUI 0.46 的 `/userdata/workflows` 返回 403，插件改为直接扫描磁盘目录（默认从 ComfyUI 的 `--output-directory` 推导出 `user/default/workflows`），因此仍能自动列出工作流。若你的 ComfyUI 装在非标准位置，可在 `cordis.patch.yml` 的 `dsh-comfyui-desk` 配置里加 `workflowDirs: ['D:/path/to/workflows']`。
- 画布格式工作流转换支持连线、静音节点和控件值；**被旁通（bypass）的节点不会自动重接连线**，会被跳过并在警告里说明。
- 画布里的 `Note` / `Reroute` / `PrimitiveNode` 是纯界面节点，提交时会自动剔除（`Reroute` 会直通重连下游），并给出警告；同理，本机未安装的自定义节点也会被跳过，避免 ComfyUI 返回 `400 missing_node_type`。
- 画布导出的 `widgets_values` 顺序可能与后端 schema 不同（例如 KSampler 在 seed 后多了 `control_after_generate`），转换时会按非连线输入重新对齐，确保 steps / cfg / 采样器等参数不串位。
- 进度使用 HTTP 轮询而非 WebSocket；足够显示节点进度，但不像原生界面那样逐帧预览。
- 双向同步需要重启 ComfyUI 加载桥接扩展；且 ComfyUI → DSH 方向依赖 **保存工作流** 写盘，未保存的画布改动不会被 DSH 感知。
- 画布内暂不支持连线重连与新建节点；需要这类改动请在 ComfyUI 原生画布里做，保存后 DSH 会自动刷新。
- 工作流字段的语义识别（正向/负向/采样器/latent）基于常见节点类型；极少数自定义架构可能识别不到，此时可在节点映射里直接改 `节点ID.输入名`。
- AI 写提示词需要 DSH 会话提供可用的 `llm` 服务；模型从 DSH 模型库选，默认沿用当前会话模型。若模型库为空，先在 DSH 设置里配置 provider。
- DSH 处于 developer preview，升级 DSH 后建议重新跑一次自检。

## 验证记录（2026-11-23）

- `node tools/smoke.mjs`：全部通过（48 条路由、23 个客户端请求路径、9 个 Agent 工具，含写回/版本号回归）；本机 ComfyUI 0.46.0 在线
- 双向同步：`/workflow-revision` 与 `/workflow-file` 实测返回磁盘版本号与原始画布文档；`applyCanvasEdit` + `writeWorkflow` 实测坐标/控件写盘且版本号变化；桥接扩展 Python 语法编译通过
- `GET /status`：读到 RTX 5060 Laptop GPU、显存、内存、队列；CPU 使用率由两次采样差值算出，GPU 利用率由 `nvidia-smi` 读取（实测 5%），不可用时前端自动退回显示显存/内存占用进度条
- `GET /models`：读到 4 个 checkpoint 与全部采样器
- `GET /history` / `GET /progress`：读到已完成任务的图片输出
- `GET /view`：成功代理返回 753 KB PNG
- `POST /save-image` / `GET /images`：成功存入并列出图片；`GET /images?dir=自定义目录` 实测列出该目录图片，`DELETE /library-file?name=...&dir=...` 实测删除成功
- `POST /upload`：成功上传到 ComfyUI input 目录
- `POST /parse-workflow`：成功解析 API 格式工作流并生成节点映射
- 因 ComfyUI 队列中有其它任务，未插入测试生成任务；`/run` 路径已通过本地单元自检与参考实现对照
