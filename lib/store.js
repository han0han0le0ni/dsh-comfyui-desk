/** 本地图片库：浏览用户指定的文件夹，也可把 ComfyUI 输出复制进来。 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ComfyError, safeFilename } from './comfy.js'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])

/** 用户可在面板里指定任意目录（override）；未指定时用插件配置，再回退到 Pictures/DSH-ComfyUI。 */
export function resolveLibraryDir(config = {}, override = '') {
  const fromPanel = String(override ?? '').trim()
  const configured = fromPanel || String(config.libraryDir ?? '').trim()
  if (configured === '') return path.join(os.homedir(), 'Pictures', 'DSH-ComfyUI')
  return path.isAbsolute(configured) ? path.resolve(configured) : path.join(os.homedir(), configured)
}

export async function ensureLibraryDir(config = {}, override = '') {
  const dir = resolveLibraryDir(config, override)
  await mkdir(dir, { recursive: true })
  return dir
}

/** 用系统文件管理器打开目录（Windows 资源管理器 / macOS Finder / Linux xdg-open）。 */
export async function openFolder(dir) {
  const target = path.resolve(String(dir ?? '').trim())
  if (!target) throw new ComfyError('文件夹路径为空', { code: 'bad-dir' })
  await mkdir(target, { recursive: true })
  let command
  let args
  if (process.platform === 'win32') {
    command = 'explorer.exe'
    args = [target]
  } else if (process.platform === 'darwin') {
    command = 'open'
    args = [target]
  } else {
    command = 'xdg-open'
    args = [target]
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => {})
    child.unref()
  } catch (error) {
    throw new ComfyError(`打开文件夹失败：${error.message}`, { code: 'open-folder' })
  }
  return { ok: true, path: target }
}

export async function listImages(config = {}, limit = 60, override = '') {
  const dir = resolveLibraryDir(config, override)
  const fromPanel = String(override ?? '').trim()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new ComfyError(`读取图片库失败：${error.message}`, { code: 'library' })
  }
  const images = await Promise.all(entries
    .filter((entry) => entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase()))
    .map(async (entry) => {
      const full = path.join(dir, entry.name)
      const info = await stat(full).catch(() => null)
      return {
        name: entry.name,
        size: Number(info?.size ?? 0),
        modifiedAt: Number(info?.mtimeMs ?? 0),
        url: `/api/dsh-comfyui-desk/library-file?name=${encodeURIComponent(entry.name)}`
          + (fromPanel ? `&dir=${encodeURIComponent(fromPanel)}` : ''),
      }
    }))
  images.sort((a, b) => b.modifiedAt - a.modifiedAt)
  // limit <= 0 表示不限张数（显示整目录）；否则截断到指定值，硬上限 5000 防止极端情况卡死。
  const raw = Number(limit)
  const capped = !Number.isFinite(raw) || raw <= 0 ? 0 : Math.min(Math.floor(raw), 5000)
  return capped > 0 ? images.slice(0, capped) : images
}

export async function saveImage(config, bytes, suggestedName, override = '') {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new ComfyError('图片内容为空', { code: 'empty-image' })
  const dir = await ensureLibraryDir(config, override)
  let name = safeFilename(suggestedName, `image-${Date.now()}.png`)
  if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) name += '.png'
  const full = path.join(dir, name)
  await writeFile(full, bytes)
  return {
    name, path: full, size: bytes.length,
    url: `/api/dsh-comfyui-desk/library-file?name=${encodeURIComponent(name)}`
      + (String(override ?? '').trim() ? `&dir=${encodeURIComponent(override)}` : ''),
  }
}

export async function readImage(config, name, override = '') {
  if (typeof name !== 'string' || name === '' || name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new ComfyError('图片名不合法', { code: 'bad-name' })
  }
  const full = path.join(resolveLibraryDir(config, override), name)
  try {
    return { bytes: await readFile(full), name, full }
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ComfyError(`图片不存在：${name}`, { status: 404, code: 'not-found' })
    throw new ComfyError(`读取图片失败：${error.message}`, { code: 'library' })
  }
}

export async function deleteImage(config, name, override = '') {
  if (typeof name !== 'string' || name === '' || name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new ComfyError('图片名不合法', { code: 'bad-name' })
  }
  const full = path.join(resolveLibraryDir(config, override), name)
  try {
    await unlink(full)
    return { ok: true, name }
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ComfyError(`图片不存在：${name}`, { status: 404, code: 'not-found' })
    throw new ComfyError(`删除图片失败：${error.message}`, { code: 'library' })
  }
}
