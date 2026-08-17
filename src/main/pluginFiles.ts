import { app } from 'electron'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { PLUGIN_ID_RE } from '@shared/plugins'
import type { PluginFileEntry } from '@shared/ipc'

/**
 * 插件文件存储（契约见 docs/插件契约.md §6，设计文档 docs/plugins/notes/数据与存储.md）。
 * 位置：userData/plugin-data/<id>/files/ —— 供文件型插件（知识库/笔记等）按文件读写；
 * 与 plugin-data（key-value JSON）并存；卸载保留数据（与 plugin-data 一致）。
 */

const FILES_ROOT = 'files'
/** 单文件大小上限（UTF-8 字节） */
const MAX_FILE_SIZE = 1024 * 1024
/** 相对路径上限 */
const MAX_PATH_LENGTH = 256

export function pluginFilesRoot(id: string): string {
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    throw new Error(`无效的插件 id: ${String(id)}`)
  }
  return join(app.getPath('userData'), 'plugin-data', id, FILES_ROOT)
}

/** 相对路径校验 + 解析（防目录穿越：无前导 /、无 .. 段、无空段、无 NUL、≤256） */
function resolveSafe(id: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > MAX_PATH_LENGTH) {
    throw new Error('无效的文件路径')
  }
  if (
    relPath.startsWith('/') ||
    relPath.startsWith('\\') ||
    relPath.includes('\0') ||
    relPath.includes(':') ||
    /\s/.test(relPath)
  ) {
    throw new Error('无效的文件路径')
  }
  const segments = relPath.split(/[\\/]/)
  if (segments.some((s) => s === '..' || s === '' || s === '.')) {
    throw new Error('无效的文件路径')
  }
  const root = resolve(pluginFilesRoot(id))
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + '\\') && !target.startsWith(root + '/')) {
    throw new Error('无效的文件路径')
  }
  return target
}

/** 读取文件（UTF-8） */
export async function readPluginFile(id: string, relPath: string): Promise<string> {
  return readFile(resolveSafe(id, relPath), 'utf-8')
}

/** 写入文件（原子：临时文件 + rename；自动建父目录；超限拒绝） */
export async function writePluginFile(
  id: string,
  relPath: string,
  content: string,
): Promise<void> {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
    throw new Error(`文件内容必须是 ≤${MAX_FILE_SIZE} 字节的字符串`)
  }
  const file = resolveSafe(id, relPath)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, content, 'utf-8')
  await rename(tmp, file)
}

/** 列目录（可选相对子目录；缺省列根）。文件夹在前，名称排序 */
export async function listPluginFiles(
  id: string,
  dirRel?: string,
): Promise<PluginFileEntry[]> {
  const dir = dirRel == null || dirRel === '' ? pluginFilesRoot(id) : resolveSafe(id, dirRel)
  await mkdir(dir, { recursive: true })
  const entries = await readdir(dir, { withFileTypes: true })
  const out: PluginFileEntry[] = []
  for (const e of entries) {
    const abs = join(dir, e.name)
    const st = await stat(abs)
    // 契约路径统一正斜杠（`a/b.md`）。path.join 在 Windows 产生反斜杠，这里归一化——
    // 否则渲染层按 `/` 拆分（lastIndexOf('/') 算父目录等）会算错，删除/移动后不刷新树。
    const rel = dirRel ? join(dirRel, e.name) : e.name
    out.push({
      name: e.name,
      path: rel.replace(/\\/g, '/'),
      isDirectory: e.isDirectory(),
      size: st.size,
      mtimeMs: st.mtimeMs,
      createdMs: st.birthtimeMs,
    })
  }
  return out.sort(
    (a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) ||
      a.name.localeCompare(b.name, 'zh-CN'),
  )
}

/** 删除文件/文件夹（递归；仅限插件文件根内，路径已校验） */
export async function removePluginFile(id: string, relPath: string): Promise<void> {
  const target = resolveSafe(id, relPath)
  await rm(target, { recursive: true, force: true })
}

/** 建文件夹（可多级） */
export async function mkPluginDir(id: string, relPath: string): Promise<void> {
  const target = resolveSafe(id, relPath)
  await mkdir(target, { recursive: true })
}

/** 复制（文件/文件夹递归；目标已存在抛错） */
export async function copyPluginFile(id: string, from: string, to: string): Promise<void> {
  const source = resolveSafe(id, from)
  const target = resolveSafe(id, to)
  if (source === target) throw new Error('源与目标相同')
  await cp(source, target, { recursive: true, force: false, errorOnExist: true })
}

/** 移动/重命名（文件/文件夹递归；跨盘回退复制+删除） */
export async function movePluginFile(id: string, from: string, to: string): Promise<void> {
  const source = resolveSafe(id, from)
  const target = resolveSafe(id, to)
  if (source === target) return
  try {
    await rename(source, target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(source, target, { recursive: true, force: false, errorOnExist: true })
    await rm(source, { recursive: true, force: true })
  }
}
