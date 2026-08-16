import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppSettings, SettingsPatch } from '@shared/settings'
import { PLUGIN_ID_RE } from '@shared/plugins'

const SETTINGS_FILE = 'settings.json'

const DEFAULTS: AppSettings = {
  version: 1,
  theme: 'light',
  disabledPlugins: [],
  sidebarCollapsed: false,
  safeMode: false,
  agentInstalled: true,
}

let cache: AppSettings | null = null
/** 串行化写入队列，避免并发写坏文件 */
let writeChain: Promise<void> = Promise.resolve()

function filePath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

async function load(): Promise<AppSettings> {
  try {
    const raw = await readFile(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULTS
    return {
      version: 1,
      theme: parsed.theme === 'dark' ? 'dark' : 'light',
      disabledPlugins: Array.isArray(parsed.disabledPlugins)
        ? parsed.disabledPlugins.filter((id): id is string => typeof id === 'string')
        : [],
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      safeMode: parsed.safeMode === true,
      agentInstalled: parsed.agentInstalled !== false,
    }
  } catch {
    return DEFAULTS
  }
}

/** 读取设置（惰性加载 + 内存缓存） */
export async function getSettings(): Promise<AppSettings> {
  if (!cache) cache = await load()
  return cache
}

/** 原子写：临时文件 + rename；写入排队串行执行 */
function persist(next: AppSettings): Promise<void> {
  const task = async (): Promise<void> => {
    const file = filePath()
    const tmp = `${file}.tmp`
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8')
    await rename(tmp, file)
  }
  writeChain = writeChain.then(task, task)
  return writeChain
}

/** 合并更新设置（白名单校验）并持久化 */
export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  const current = await getSettings()
  const next: AppSettings = { ...current, version: 1 }

  if (patch.theme !== undefined) {
    if (patch.theme !== 'light' && patch.theme !== 'dark') {
      throw new Error('settings: theme 必须是 light 或 dark')
    }
    next.theme = patch.theme
  }
  if (patch.disabledPlugins !== undefined) {
    if (!Array.isArray(patch.disabledPlugins)) {
      throw new Error('settings: disabledPlugins 必须是数组')
    }
    const ids = patch.disabledPlugins.filter(
      (id): id is string => typeof id === 'string' && PLUGIN_ID_RE.test(id),
    )
    next.disabledPlugins = [...new Set(ids)] // 去重
  }
  if (patch.sidebarCollapsed !== undefined) {
    if (typeof patch.sidebarCollapsed !== 'boolean') {
      throw new Error('settings: sidebarCollapsed 必须是布尔值')
    }
    next.sidebarCollapsed = patch.sidebarCollapsed
  }
  if (patch.safeMode !== undefined) {
    if (typeof patch.safeMode !== 'boolean') {
      throw new Error('settings: safeMode 必须是布尔值')
    }
    next.safeMode = patch.safeMode
  }
  if (patch.agentInstalled !== undefined) {
    if (typeof patch.agentInstalled !== 'boolean') {
      throw new Error('settings: agentInstalled 必须是布尔值')
    }
    next.agentInstalled = patch.agentInstalled
  }

  cache = next
  await persist(next)
  return next
}
