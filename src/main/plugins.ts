import { app, dialog, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { watch, type FSWatcher } from 'node:fs'
import { cp, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import extract from 'extract-zip'
import { getSettings } from './settings'
import { clearPluginData } from './pluginData'
import type { ExternalPluginManifest, PluginDetail, PluginInfo } from '@shared/plugins'
import { PLUGIN_ENTRY_EXT, PLUGIN_ID_RE, PLUGIN_SLOTS, PLUGIN_TAG_RE } from '@shared/plugins'
import type { HostAppManifest } from '@shared/hostApp'

/** entry 源码大小上限（2MB），防内存膨胀 */
const MAX_ENTRY_SIZE = 2 * 1024 * 1024
/** 图标文件大小上限（64KB），防列表 payload 膨胀 */
const MAX_ICON_SIZE = 64 * 1024
/** 图标允许的扩展名 */
const PLUGIN_ICON_EXT = ['.svg', '.png']

interface ScannedPlugin {
  info: ExternalPluginManifest
  /** 经 realpath 的插件目录绝对路径 */
  dir: string
  /** 解析后的入口绝对路径（仅 webComponent） */
  entryAbs?: string
  /** 图标 data URL（从 manifest.icon 读取生成，供 list 返回） */
  iconDataUrl?: string
}

/** 扫描结果缓存（只认 id 读取，防止渲染层传入任意路径） */
const cache = new Map<string, ScannedPlugin>()
/** 插件目录 watcher（防 GC，重复调用时先关闭旧的） */
let watcher: FSWatcher | null = null

/** 插件根目录：dev 用工程内 resources/plugins，prod 用 userData/plugins（安装目录只读） */
export function pluginsRoot(): string {
  return is.dev
    ? join(app.getAppPath(), 'resources', 'plugins')
    : join(app.getPath('userData'), 'plugins')
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}

/** p 是否位于 root 之内（真实路径比较） */
function isWithin(p: string, root: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** env 变量名（禁止注入：只能大写字母/数字/下划线开头大写） */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/
/** npm 包名（拼进 npm install 命令 —— 最高注入风险点，严格白名单） */
const PKG_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
/** hostBin 相对路径（无前导 /、无 ..、无空白） */
const HOST_BIN_RE = /^[a-zA-Z0-9_./-]+$/
/** hostDir 相对路径（插件目录内代码根；无前导 /、无 .. 段、无空白、≤256） */
const HOST_DIR_RE = /^[a-zA-Z0-9_./-]+$/

function isValidHostDir(v: string): boolean {
  if (v.length > 256 || !HOST_DIR_RE.test(v)) return false
  if (v.startsWith('/') || v.startsWith('\\')) return false
  return v.split(/[\\/]/).every((seg) => seg !== '..' && seg !== '')
}
/** 数据/运行时目录名（单段，禁分隔符） */
const DIR_NAME_RE = /^[a-zA-Z0-9_-]+$/

/** 校验 hostApp 定义（manifest 的 hostApp 字段），非法返回 null（防注入） */
function validateHostAppManifest(v: unknown): HostAppManifest | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const h = v as Record<string, unknown>
  const s = (x: unknown, max: number): string | null =>
    typeof x === 'string' && x.length > 0 && x.length <= max ? x : null

  const packageName = s(h.packageName, 128)
  if (!packageName || !PKG_NAME_RE.test(packageName)) return null
  const hostBin = s(h.hostBin, 256)
  if (!hostBin || !HOST_BIN_RE.test(hostBin) || hostBin.startsWith('/') || hostBin.includes('..')) {
    return null
  }
  const hostDir = s(h.hostDir, 256)
  if (hostDir !== null && !isValidHostDir(hostDir)) return null
  if (!Array.isArray(h.cliArgs) || h.cliArgs.length > 32) return null
  for (const a of h.cliArgs) {
    if (typeof a !== 'string' || a.length > 256 || a.includes('\0')) return null
  }
  const readyRe = s(h.readyRe, 512)
  if (!readyRe) return null
  let re: RegExp
  try {
    re = new RegExp(readyRe)
  } catch {
    return null
  }
  // 非 g/sticky（agent.ts 反复 .exec 取 m[1]）；须 ≥1 捕获组（端口）
  if (re.global || re.sticky || re.source.indexOf('(') < 0) return null
  const dataHomeEnv = s(h.dataHomeEnv, 64)
  if (!dataHomeEnv || !ENV_NAME_RE.test(dataHomeEnv)) return null
  const dataDir = s(h.dataDir, 64)
  if (!dataDir || !DIR_NAME_RE.test(dataDir)) return null
  const runtimeDir = s(h.runtimeDir, 64)
  if (!runtimeDir || !DIR_NAME_RE.test(runtimeDir)) return null
  if (!h.extraEnv || typeof h.extraEnv !== 'object' || Array.isArray(h.extraEnv)) return null
  const extraEnv: Record<string, string> = {}
  for (const [k, val] of Object.entries(h.extraEnv)) {
    if (!ENV_NAME_RE.test(k) || typeof val !== 'string' || val.length > 1024) return null
    extraEnv[k] = val
  }
  return {
    packageName,
    hostBin,
    ...(hostDir !== null ? { hostDir } : {}),
    cliArgs: h.cliArgs as string[],
    readyRe,
    dataHomeEnv,
    dataDir,
    runtimeDir,
    extraEnv,
  }
}

/** 已扫描插件的目录（hostApp 本地宿主解析用）；未扫描/不存在返回 null */
export function getPluginDir(id: string): string | null {
  return cache.get(id)?.dir ?? null
}

/** 详情扩展字段（可选）：非法值丢弃（仅展示用），不拒整个 manifest */
const URL_RE = /^https?:\/\/\S+$/
const TAG_RE = /^[a-z0-9-]+$/

function detailMeta(
  m: Record<string, unknown>,
): Pick<
  ExternalPluginManifest,
  'homepage' | 'repository' | 'license' | 'tags' | 'categories' | 'dependencies'
> {
  const url = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length <= 512 && URL_RE.test(v) ? v : undefined
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined
  const tagsArr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v) || v.length > 8) return undefined
    const out: string[] = []
    for (const t of v) {
      if (typeof t !== 'string' || !TAG_RE.test(t) || t.length > 32) return undefined
      out.push(t)
    }
    return out.length ? out : undefined
  }
  const depsArr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v) || v.length > 16) return undefined
    const out: string[] = []
    for (const d of v) {
      if (typeof d !== 'string' || !PLUGIN_ID_RE.test(d)) return undefined
      out.push(d)
    }
    return out.length ? out : undefined
  }
  return {
    homepage: url(m.homepage),
    repository: url(m.repository),
    license: str(m.license, 128),
    tags: tagsArr(m.tags),
    categories: tagsArr(m.categories),
    dependencies: depsArr(m.dependencies),
  }
}

/** 校验 manifest.json，返回合法 manifest 或 null（非法整体跳过并告警） */
export async function readAndValidateManifest(dir: string): Promise<ExternalPluginManifest | null> {
  const raw = await readFile(join(dir, 'manifest.json'), 'utf-8').catch(() => null)
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`[plugins] ${dir}/manifest.json 不是合法 JSON，跳过`)
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[plugins] ${dir}/manifest.json 必须是纯对象，跳过`)
    return null
  }
  const m = parsed as Record<string, unknown>

  const kind =
    m.kind === 'hostApp'
      ? 'hostApp'
      : m.kind === 'webComponent' || m.kind === undefined
        ? 'webComponent'
        : null
  if (!kind) {
    console.warn(`[plugins] ${dir}/manifest.json kind 非法（仅 hostApp/webComponent），跳过`)
    return null
  }

  const id = m.id
  const name = m.name
  const slot = m.slot
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length <= 128 ? v : undefined
  const order = m.order === undefined ? undefined : Number(m.order)

  // 公共必填：id / name / slot
  if (
    typeof id !== 'string' ||
    !PLUGIN_ID_RE.test(id) ||
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof slot !== 'string' ||
    !PLUGIN_SLOTS.includes(slot as (typeof PLUGIN_SLOTS)[number])
  ) {
    console.warn(`[plugins] ${dir}/manifest.json 必填字段不合法（id/name/slot），跳过`)
    return null
  }

  if (kind === 'hostApp') {
    const hostApp = validateHostAppManifest(m.hostApp)
    if (!hostApp) {
      console.warn(`[plugins] ${dir}/manifest.json hostApp 定义不合法，跳过`)
      return null
    }
    const iconName =
      typeof m.iconName === 'string' && /^[a-z][a-z0-9]*$/.test(m.iconName) ? m.iconName : undefined
    return {
      id,
      name,
      kind: 'hostApp',
      shortName: str(m.shortName),
      iconName,
      version: str(m.version),
      description: str(m.description),
      publisher: str(m.publisher),
      slot,
      order: Number.isFinite(order) ? order : undefined,
      hostApp,
      ...detailMeta(m),
    }
  }

  // webComponent：tag + entry 必填（维持现状）
  const tag = m.tag
  const entry = m.entry
  if (typeof tag !== 'string' || !PLUGIN_TAG_RE.test(tag) || typeof entry !== 'string') {
    console.warn(`[plugins] ${dir}/manifest.json 必填字段不合法（tag/entry），跳过`)
    return null
  }
  return {
    id,
    name,
    kind: 'webComponent',
    version: str(m.version),
    description: str(m.description),
    publisher: str(m.publisher),
    tag,
    slot,
    order: Number.isFinite(order) ? order : undefined,
    entry,
    icon: str(m.icon), // 图标相对路径（.svg/.png）；list 时主进程读为 data URL
    ...detailMeta(m),
  }
}

/** 解析相对资源路径：非绝对、扩展名白名单、无 ..、位于 dir 内；非法返回 null */
function resolveRelative(dir: string, rel: string, exts: string[]): string | null {
  if (typeof rel !== 'string' || isAbsolute(rel)) return null
  if (!exts.includes(extname(rel))) return null
  const normalized = normalize(rel)
  if (
    normalized === '..' ||
    normalized.startsWith(`..${'/'}`) ||
    normalized.startsWith(`..${'\\'}`)
  ) {
    return null
  }
  const abs = resolve(dir, normalized)
  return isWithin(abs, dir) ? abs : null
}

/** 解析并校验入口路径（.js/.mjs） */
function resolveEntry(dir: string, entry: string): string | null {
  return resolveRelative(dir, entry, PLUGIN_ENTRY_EXT)
}

/** 读取插件图标并转为 data URL；无图标/非法/过大/读取失败 → undefined */
async function readIconDataUrl(dir: string, icon: string | undefined): Promise<string | undefined> {
  if (!icon) return undefined
  const abs = resolveRelative(dir, icon, PLUGIN_ICON_EXT)
  if (!abs) return undefined
  try {
    const info = await stat(abs)
    if (info.size > MAX_ICON_SIZE) return undefined
    const buf = await readFile(abs)
    const mime = extname(abs) === '.svg' ? 'image/svg+xml' : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return undefined
  }
}

/** 全量扫描插件目录并重建缓存（目录不存在 → 空，不抛错） */
async function scan(): Promise<void> {
  cache.clear()
  const root = await realpathOrNull(pluginsRoot())
  if (!root) return

  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const realDir = await realpathOrNull(join(root, ent.name))
    if (!realDir || !isWithin(realDir, root)) {
      console.warn(`[plugins] 跳过目录「${ent.name}」：不在插件根目录内或为符号链接逃逸`)
      continue
    }
    const manifest = await readAndValidateManifest(realDir)
    if (!manifest) continue
    // hostApp：无入口；webComponent 需解析入口
    let entryAbs: string | undefined
    if (manifest.kind === 'webComponent') {
      const resolved = resolveEntry(realDir, manifest.entry!)
      if (!resolved) {
        console.warn(`[plugins] 插件「${manifest.id}」入口不合法（${manifest.entry}），跳过`)
        continue
      }
      entryAbs = resolved
    }
    if (cache.has(manifest.id)) {
      console.warn(`[plugins] 插件 id「${manifest.id}」重复，先到先得，跳过`)
      continue
    }
    // tag 唯一性仅对 webComponent 有意义（hostApp 无 tag，undefined===undefined 会误判重复）
    if (
      manifest.kind === 'webComponent' &&
      [...cache.values()].some((p) => p.info.kind === 'webComponent' && p.info.tag === manifest.tag)
    ) {
      console.warn(`[plugins] 插件 tag「${manifest.tag}」重复，先到先得，跳过`)
      continue
    }
    const iconDataUrl = await readIconDataUrl(realDir, manifest.icon)
    cache.set(manifest.id, {
      info: manifest,
      dir: realDir,
      entryAbs,
      iconDataUrl,
    })
  }
}

/** 列出外部插件（扫描 + 合并 enabled），按 order 升序 */
export async function listPlugins(): Promise<PluginInfo[]> {
  await scan()
  const { disabledPlugins } = await getSettings()
  const disabled = new Set(disabledPlugins)
  return [...cache.values()]
    .map((s) => ({ ...s.info, icon: s.iconDataUrl, enabled: !disabled.has(s.info.id) }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/** README/CHANGELOG 读取大小上限（64KB，防详情 payload 膨胀） */
const MAX_DOC_SIZE = 64 * 1024

/** 插件详情：完整 manifest + README.md + CHANGELOG.md（详情页用；按 id 只认缓存） */
export async function getPluginDetail(id: string): Promise<PluginDetail | null> {
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) return null
  const scanned = cache.get(id)
  if (!scanned) return null
  const { disabledPlugins } = await getSettings()
  const disabled = new Set(disabledPlugins)
  const info: PluginInfo = {
    ...scanned.info,
    icon: scanned.iconDataUrl,
    enabled: !disabled.has(id),
  }
  const readDoc = async (name: string): Promise<string | undefined> => {
    try {
      const buf = await readFile(join(scanned.dir, name))
      if (buf.length > MAX_DOC_SIZE) return buf.subarray(0, MAX_DOC_SIZE).toString('utf-8')
      return buf.toString('utf-8')
    } catch {
      return undefined
    }
  }
  return {
    ...info,
    readme: await readDoc('README.md'),
    changelog: await readDoc('CHANGELOG.md'),
  }
}

/** 按 id 读取入口源码（只认 id；路径穿越/越界/大小防护） */
export async function loadPluginScript(id: string): Promise<string> {
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    throw new Error('无效的插件 id')
  }
  const scanned = cache.get(id)
  if (!scanned) throw new Error(`插件「${id}」不存在，请先重新扫描`)
  if (scanned.info.kind === 'hostApp' || !scanned.entryAbs) {
    throw new Error(`插件「${id}」不是可加载脚本的插件（hostApp 无入口）`)
  }

  const realEntry = await realpathOrNull(scanned.entryAbs)
  if (!realEntry) throw new Error(`插件「${id}」入口文件不存在`)
  const root = await realpathOrNull(pluginsRoot())
  if (!root || !isWithin(realEntry, root)) {
    throw new Error(`插件「${id}」入口路径越界，已拒绝`)
  }
  const info = await stat(realEntry)
  if (info.size > MAX_ENTRY_SIZE) {
    throw new Error(`插件「${id}」入口超过大小上限（${MAX_ENTRY_SIZE} 字节）`)
  }
  return await readFile(realEntry, 'utf-8')
}

/**
 * 卸载插件：删除插件根目录的直接子目录（安全校验后），并清缓存。
 * clearData=true 时同时清空 userData/plugin-data/<id>（契约见 docs/插件契约.md §5；
 * 默认保留数据，重装可恢复）。
 */
export async function uninstallPlugin(id: string, clearData = false): Promise<void> {
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
    throw new Error('无效的插件 id')
  }
  const scanned = cache.get(id)
  if (!scanned) throw new Error(`插件「${id}」不存在`)

  const root = await realpathOrNull(pluginsRoot())
  if (!root) throw new Error('插件目录不存在')
  const realDir = await realpathOrNull(scanned.dir)
  // 只允许删除插件根目录的直接子目录，拒绝越界/删根
  if (!realDir || realDir === root || !isWithin(realDir, root) || dirname(realDir) !== root) {
    throw new Error(`插件「${id}」目录越界，拒绝卸载`)
  }

  await rm(realDir, { recursive: true, force: true })
  cache.delete(id)
  if (clearData) {
    await clearPluginData(id)
  }
}

/** 从本地 zip 手动导入插件：文件对话框选 zip → 临时解压 → 校验 manifest → 复制进插件根 */
export async function importLocalPlugin(win: BrowserWindow | null): Promise<boolean> {
  const res = win
    ? await dialog.showOpenDialog(win, {
        title: '从本地安装插件',
        filters: [{ name: '插件包', extensions: ['zip'] }],
        properties: ['openFile'],
      })
    : await dialog.showOpenDialog({
        title: '从本地安装插件',
        filters: [{ name: '插件包', extensions: ['zip'] }],
        properties: ['openFile'],
      })
  if (res.canceled || !res.filePaths[0]) return false
  const zipPath = res.filePaths[0]

  const root = await realpathOrNull(pluginsRoot())
  if (!root) throw new Error('插件目录不可用')

  // 在系统临时目录解压，避免 zip-slip 写入插件根；只取校验通过后的插件目录复制进来
  const staging = join(app.getPath('temp'), `app-plugin-import-${Date.now()}`)
  try {
    await mkdir(staging, { recursive: true })
    await extract(zipPath, { dir: staging })

    const pluginDir = await findManifestDir(staging)
    if (!pluginDir) {
      throw new Error(
        'zip 中未找到可导入的插件包：manifest.json 需位于压缩包根目录或一级子目录。请直接压缩插件目录本身（如 demo-host 文件夹），不要压缩上层目录。',
      )
    }
    const manifest = await readAndValidateManifest(pluginDir)
    if (!manifest) throw new Error('插件 manifest 不合法，已拒绝导入')

    const dest = join(root, manifest.id)
    if (await exists(dest)) throw new Error(`插件「${manifest.id}」已存在，请先卸载再导入`)

    await cp(pluginDir, dest, { recursive: true })
    return true
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** 在解压目录里找含 manifest.json 的插件目录（压缩包根目录或一级子目录；更深层级不支持） */
export async function findManifestDir(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.some((e) => e.isFile() && e.name === 'manifest.json')) return dir
  for (const e of entries) {
    if (e.isDirectory()) {
      const sub = join(dir, e.name)
      const subEntries = await readdir(sub, { withFileTypes: true }).catch(() => [])
      if (subEntries.some((x) => x.isFile() && x.name === 'manifest.json')) return sub
    }
  }
  return null
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** 监听插件目录变化（新装/卸载/改动），防抖后回调；目录不存在则先创建 */
export async function watchPluginDir(onChange: () => void): Promise<void> {
  const root = pluginsRoot()
  try {
    await mkdir(root, { recursive: true })
  } catch {
    // 目录不可建时跳过监听
  }
  if (watcher) watcher.close()

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    watcher = watch(root, { recursive: true }, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => onChange(), 500)
    })
    watcher.on('error', (err) => {
      console.warn('[plugins] 插件目录监听错误：', err)
    })
  } catch (err) {
    console.warn('[plugins] 无法监听插件目录：', err)
  }
}
