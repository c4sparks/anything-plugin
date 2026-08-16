import { app } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PLUGIN_ID_RE } from '@shared/plugins'

/**
 * webComponent 插件数据存储（契约见 docs/插件契约.md §5）。
 * 位置：userData/plugin-data/<id>/data.json —— 独立于插件目录与浏览器存储，
 * 不随浏览器数据清理丢失；卸载插件只删插件目录，数据保留（数据归用户）。
 */

const DATA_ROOT = 'plugin-data'
const DATA_FILE = 'data.json'
/** 单 key 值上限（字符数） */
const MAX_VALUE_LENGTH = 512 * 1024
/** 单插件数据文件上限（UTF-8 字节数） */
const MAX_FILE_SIZE = 4 * 1024 * 1024

/** 数据 key 白名单：小写开头，字母/数字/._-，≤64 */
export const PLUGIN_DATA_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/

export function pluginDataRoot(): string {
  return join(app.getPath('userData'), DATA_ROOT)
}

/** 插件数据目录（id 强校验，防目录穿越） */
export function pluginDataDir(id: string): string {
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    throw new Error(`无效的插件 id: ${String(id)}`)
  }
  return join(pluginDataRoot(), id)
}

function dataFile(id: string): string {
  return join(pluginDataDir(id), DATA_FILE)
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !PLUGIN_DATA_KEY_RE.test(key)) {
    throw new Error(`无效的数据 key: ${String(key)}`)
  }
}

/** 串行化写入队列，避免并发写坏文件（与 settings.ts 同模式） */
let writeChain: Promise<void> = Promise.resolve()

/** 读取插件数据对象；文件缺失/JSON 损坏按空对象处理（写入即重建） */
async function load(id: string): Promise<Record<string, string>> {
  const file = dataFile(id) // 先解析并校验 id（非法即抛，不被下方 catch 吞掉）
  try {
    const raw = await readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (PLUGIN_DATA_KEY_RE.test(k) && typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 原子写：临时文件 + rename（目录不存在先建） */
async function persist(id: string, data: Record<string, string>): Promise<void> {
  const file = dataFile(id)
  const tmp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmp, file)
}

/** 读取单个 key（不存在返回 null） */
export async function getPluginData(id: string, key: string): Promise<string | null> {
  validateKey(key)
  const data = await load(id)
  return data[key] ?? null
}

/** 写入单个 key（原子 + 串行；超限抛错） */
export async function setPluginData(id: string, key: string, value: string): Promise<void> {
  validateKey(key)
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
    throw new Error(`数据值必须是 ≤${MAX_VALUE_LENGTH} 字符的字符串`)
  }
  const task = async (): Promise<void> => {
    const data = await load(id)
    data[key] = value
    if (Buffer.byteLength(JSON.stringify(data), 'utf-8') > MAX_FILE_SIZE) {
      throw new Error(`插件数据超过 ${MAX_FILE_SIZE} 字节上限`)
    }
    await persist(id, data)
  }
  writeChain = writeChain.then(task, task)
  return writeChain
}

/** 删除单个 key（不存在幂等） */
export async function removePluginData(id: string, key: string): Promise<void> {
  validateKey(key)
  const task = async (): Promise<void> => {
    const data = await load(id)
    if (!(key in data)) return
    delete data[key]
    await persist(id, data)
  }
  writeChain = writeChain.then(task, task)
  return writeChain
}

/** 清空整个插件数据目录（该插件全部数据） */
export async function clearPluginData(id: string): Promise<void> {
  const task = async (): Promise<void> => {
    await rm(pluginDataDir(id), { recursive: true, force: true })
  }
  writeChain = writeChain.then(task, task)
  return writeChain
}
