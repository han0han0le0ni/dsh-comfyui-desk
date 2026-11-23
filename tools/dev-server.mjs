/** 不启动 DSH 也能手动调试 Host 路由：node tools/dev-server.mjs [port] */
import http from 'node:http'
import { makeRoutes } from '../lib/routes.js'

const port = Number.parseInt(process.argv[2] ?? '8787', 10)
const config = {
  baseUrl: process.env.COMFY_BASE ?? 'http://127.0.0.1:8188',
  requestTimeoutMs: 10_000,
  libraryDir: process.env.DSH_COMFY_LIBRARY ?? '',
  llmProvider: process.env.DSH_LLM_PROVIDER ?? '',
  llmModel: process.env.DSH_LLM_MODEL ?? '',
}
const routes = new Map(makeRoutes({}, config).map((route) => [route.path, route.handler]))

const server = http.createServer((req, res) => {
  const pathname = String(req.url ?? '').split('?')[0]
  const handler = routes.get(pathname)
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: '未找到路由：' + pathname }))
    return
  }
  handler(req, res)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`DSH ComfyUI Desk 开发服务器：http://127.0.0.1:${port}`)
  console.log('代理目标 ComfyUI：' + config.baseUrl)
})
