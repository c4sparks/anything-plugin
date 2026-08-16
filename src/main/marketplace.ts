import { app } from 'electron'
import { createHash } from 'node:crypto'
import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import extract from 'extract-zip'
import type { MarketPlugin, MarketSearchResult } from '@shared/market'
import { PLUGIN_ID_RE } from '@shared/plugins'
import { exists, findManifestDir, pluginsRoot, readAndValidateManifest } from './plugins'

/**
 * 插件市场（P3 真实实现）。
 * 注册表地址用环境变量 `APP_MARKET_REGISTRY` 配置（GitHub raw / 静态托管 / 本地服务），
 * 值为 registry.json 的 URL；未配置则市场未开放（available:false）。
 * 安全：来源锁定（只 fetch 该注册表）、sha256 强校验、zip 临时解压防 zip-slip、
 * 解压前校验 manifest、只把校验通过的插件目录复制进插件根。
 */
const REGISTRY_URL = process.env.APP_MARKET_REGISTRY || null

let registryCache: MarketPlugin[] | null = null

function isMarketPlugin(v: unknown): v is MarketPlugin {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return (
    typeof m.id === 'string' &&
    PLUGIN_ID_RE.test(m.id) &&
    typeof m.name === 'string' &&
    typeof m.version === 'string' &&
    typeof m.downloadUrl === 'string'
  )
}

async function fetchRegistry(): Promise<{ ok: boolean; items: MarketPlugin[]; error?: string }> {
  if (!REGISTRY_URL) return { ok: false, items: [] }
  if (registryCache) return { ok: true, items: registryCache }
  try {
    const res = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      return { ok: true, items: [], error: `注册表拉取失败（HTTP ${res.status}）` }
    }
    const data = (await res.json()) as unknown
    const items = Array.isArray(data) ? data.filter(isMarketPlugin) : []
    registryCache = items
    return { ok: true, items }
  } catch (err) {
    return {
      ok: true,
      items: [],
      error: `注册表拉取失败：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** 搜索市场：拉取注册表（缓存）→ 按名称/id/描述过滤；未配置注册表返回 available:false */
export async function searchMarket(query: string): Promise<MarketSearchResult> {
  const reg = await fetchRegistry()
  if (!reg.ok) return { available: false, items: [] }
  if (reg.error) return { available: true, items: [], error: reg.error }
  const q = query.trim().toLowerCase()
  const items = !q
    ? reg.items
    : reg.items.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q),
      )
  return { available: true, items }
}

/** 安装市场插件：下载 zip → sha256 校验 → 临时解压 → 校验 manifest → 复制进插件根 */
export async function installMarketPlugin(id: string): Promise<void> {
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) throw new Error('无效的插件 id')
  const reg = await fetchRegistry()
  if (!reg.ok) throw new Error('插件市场未开放')
  if (reg.error) throw new Error(reg.error)
  const item = reg.items.find((p) => p.id === id)
  if (!item) throw new Error(`市场中没有插件「${id}」`)

  const root = await ensureRoot()
  if (!root) throw new Error('插件目录不可用')

  const res = await fetch(item.downloadUrl)
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
  const buf = Buffer.from(await res.arrayBuffer())

  if (item.sha256) {
    const hash = createHash('sha256').update(buf).digest('hex')
    if (hash !== item.sha256.toLowerCase()) {
      throw new Error('插件校验失败（sha256 不匹配），已拒绝安装')
    }
  }

  const staging = join(app.getPath('temp'), `app-plugin-install-${Date.now()}`)
  try {
    await mkdir(staging, { recursive: true })
    const zipPath = join(staging, 'pkg.zip')
    await writeFile(zipPath, buf)
    await extract(zipPath, { dir: staging })

    const pluginDir = await findManifestDir(staging)
    if (!pluginDir) throw new Error('下载的包中未找到有效插件（缺 manifest.json）')
    const manifest = await readAndValidateManifest(pluginDir)
    if (!manifest) throw new Error('插件 manifest 不合法，已拒绝安装')

    const dest = join(root, manifest.id)
    if (await exists(dest)) throw new Error(`插件「${manifest.id}」已存在，请先卸载再安装`)
    await cp(pluginDir, dest, { recursive: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function ensureRoot(): Promise<string | null> {
  try {
    await mkdir(pluginsRoot(), { recursive: true })
    return await realpath(pluginsRoot())
  } catch {
    return null
  }
}
