/** 把 client.body.js 包成 DSH 浏览器半边要求的 client.js（loader 形态）。 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BODY = path.join(ROOT, 'client.body.js')
const OUT = path.join(ROOT, 'client.js')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

function reject(message) {
  console.error('client.body.js 校验不过，拒绝生成 client.js：' + message)
  process.exit(1)
}

if (!fs.existsSync(BODY)) reject('找不到 client.body.js')
const body = fs.readFileSync(BODY, 'utf8').replace(/^\uFEFF/, '')

try {
  new vm.Script('(function (module, exports, require) {\n' + body + '\n})', { filename: 'client.body.js' })
} catch (error) {
  reject(error?.message ?? String(error))
}

for (const [label, pattern] of [
  ['顶层 import 语句', /^\s*import\s+[^(]/m],
  ['顶层 export 语句', /^\s*export\s+(const|let|var|function|class|default|\{)/m],
]) {
  if (pattern.test(body)) reject(`正文里有${label}，浏览器半边只支持 CJS 形态`)
}

const requireIds = new Set()
for (const match of body.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) requireIds.add(match[2])
const disallowed = [...requireIds].filter((id) => id !== 'react')
if (disallowed.length > 0) reject(`正文 require 了平台模块表以外的包：${disallowed.join(', ')}`)

const indented = body.split('\n').map((line) => (line.trim() === '' ? line : '\t\t' + line)).join('\n')
const generated = `/**
 * 生成物 —— 不要手改。可读源码在 client.body.js，改完跑：node tools/build-client.mjs
 * 包名 ${PKG.name} 必须与 __ModuleLoader__.load({ id }) 以及 profile 里的 loader 行一致。
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PKG.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indented}
\t\treturn module.exports;
\t},
});
`

try {
  new vm.Script(generated, { filename: 'client.js' })
} catch (error) {
  reject('产物语法错误：' + (error?.message ?? String(error)))
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (current !== generated) {
    console.error('client.js 与 client.body.js 不一致，请跑一次 node tools/build-client.mjs')
    process.exit(1)
  }
  console.log('client.js 是最新的（' + generated.length + ' 字节）')
  process.exit(0)
}

fs.writeFileSync(OUT, generated)
console.log(`已生成 ${path.relative(ROOT, OUT)}（正文 ${body.split('\n').length} 行 → ${generated.length} 字节）`)
