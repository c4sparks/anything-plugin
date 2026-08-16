import { registerPlugin } from './registry'
import type { PluginItem } from './types'
import type { PluginInfo } from '@shared/plugins'
import { compileHostAppDef, type HostAppIcon } from '@shared/hostApp'

/**
 * 外部插件加载管线。
 * - webComponent：Blob + 动态 import 执行，幂等 + 单插件隔离 + 定义后校验（无依赖、单文件、纯 ESM 原生 WC）。
 * - hostApp：不执行脚本、不读入口，直接注册（运行时由主进程 AgentManager 侧车驱动）。
 */

function toItem(info: PluginInfo): PluginItem {
  const base = {
    id: info.id,
    name: info.name,
    slot: info.slot,
    order: info.order,
    description: info.description,
    version: info.version,
    publisher: info.publisher,
    icon: info.icon,
    source: 'external' as const,
    tier: 'thirdParty' as const,
    origin: 'manual' as const,
    enabled: info.enabled,
    homepage: info.homepage,
    repository: info.repository,
    license: info.license,
    tags: info.tags,
    categories: info.categories,
    dependencies: info.dependencies,
  }
  if (info.kind === 'hostApp') {
    return {
      ...base,
      kind: 'hostApp',
      shortName: info.shortName,
      iconName: info.iconName,
      hostApp: info.hostApp
        ? compileHostAppDef(info.hostApp, {
            id: info.id,
            name: info.name,
            shortName: info.shortName,
            icon: info.iconName as HostAppIcon | undefined,
            description: info.description,
          })
        : undefined,
    }
  }
  return { ...base, kind: 'webComponent', tag: info.tag ?? '' }
}

async function executeOne(info: PluginInfo): Promise<PluginItem> {
  const base = toItem(info)
  // hostApp：无入口脚本，直接视为已加载（运行时由 start 驱动）
  if (base.kind === 'hostApp') return { ...base, status: 'ready' }
  // 幂等：HMR/重复 init 时自定义元素已定义则跳过执行
  if (base.tag && customElements.get(base.tag)) return { ...base, status: 'ready' }

  try {
    const code = await window.api.plugins.load(info.id)
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    // @vite-ignore：实参是运行时变量，Vite 不做静态分析，避免 dev/build 告警
    await import(/* @vite-ignore */ url)
    URL.revokeObjectURL(url)
    // 定义后校验：插件可能不 define 或 define 失败
    if (!base.tag || !customElements.get(base.tag)) {
      return { ...base, status: 'error', error: `执行后未定义 <${base.tag}>` }
    }
    return { ...base, status: 'ready' }
  } catch (err) {
    // 单插件隔离：一个坏插件不拖垮壳层
    return { ...base, status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

/** 加载全部外部插件；启用且成功的自动注册进注册表，返回带状态的条目列表 */
export async function loadExternalPlugins(infos: PluginInfo[]): Promise<PluginItem[]> {
  const items: PluginItem[] = []
  for (const info of infos) {
    const item = await executeOne(info)
    if (item.enabled && item.status === 'ready') {
      registerPlugin(item)
    }
    items.push(item)
  }
  return items
}
