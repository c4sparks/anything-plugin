/**
 * 插件契约：扩展功能的 UI 以自定义元素（Web Component）形式承载。
 * 注册表只认 tag，插件与框架解耦 —— Vue SFC 或原生自定义元素均可接入。
 * v0.2：新增 source / enabled / 元信息；enabled 是运行时状态（settings.json 持久化），
 * 不写入外部插件 manifest（避免第三方伪造）。
 */

import type { PluginKind as SharedPluginKind } from '@shared/plugins'
import type { HostAppDefinition } from '@shared/hostApp'

export type PluginSource = 'builtin' | 'external'

/** 插件信任分层：内置可信（主世界执行）/ 第三方受限（沙箱执行 + 安全模式） */
export type PluginTier = 'trusted' | 'thirdParty'
/** 第三方插件来源 */
export type PluginOrigin = 'market' | 'manual'

/** 插件种类：webComponent = Web Component 挂槽位；hostApp = 外部宿主应用侧车（如 dsh Agent） */
export type PluginKind = SharedPluginKind

export interface AppPlugin {
  /** 全局唯一标识 */
  id: string
  /** 展示名 */
  name: string
  /** 侧栏短名（展开态 label，缺省回退 name） */
  shortName?: string
  /** 插件种类，驱动渲染/生命周期分支 */
  kind: PluginKind
  /** hostApp 运行时定义（kind==='hostApp' 时存在；内置 dsh 用 DSH_HOST_APP） */
  hostApp?: HostAppDefinition
  /** hostApp 专用：AppIcon 命名图标（缺省通用 plugin 图标） */
  iconName?: string
  /** 自定义元素标签（仅 webComponent 必填），统一前缀 app-plugin- */
  tag?: string
  /** 挂载槽位：sidebar | content | statusbar（可扩展） */
  slot: string
  /** 同槽位内排序权重，默认 0 */
  order?: number
  description?: string
  version?: string
  publisher?: string
  /** 插件图标 data URL（外部插件由主进程从 manifest.icon 生成；内置可自行提供） */
  icon?: string
  /** 内置编译期注册 / 外部运行时加载 */
  source: PluginSource
  /** 信任分层：builtin→trusted；external→thirdParty（派生） */
  tier: PluginTier
  /** 第三方来源（market 联网 / manual 手动导入） */
  origin?: PluginOrigin
  /** 是否启用（唯一持久化来源是 settings.disabledPlugins） */
  enabled: boolean
  /** 详情扩展字段（可选，详情页展示） */
  homepage?: string
  repository?: string
  license?: string
  tags?: string[]
  categories?: string[]
  dependencies?: string[]
}

/** store 中合并后的条目：额外记录加载状态 */
export interface PluginItem extends AppPlugin {
  /** 外部插件加载状态 */
  status?: 'ready' | 'error'
  error?: string
}

/** onMount 生命周期上下文 */
export interface PluginMountContext {
  /** 当前插件条目 */
  plugin: PluginItem
}

/** 插件元素可选暴露的生命周期方法（壳层 PluginElement 在挂载/卸载时调用） */
export interface PluginLifecycleElement extends HTMLElement {
  /** 元素挂载到 DOM 后调用（内置 Vue 插件用 defineExpose 暴露，外部 WC 直接在类上定义） */
  onMount?: (ctx: PluginMountContext) => void
  /** 元素即将从 DOM 移除时调用，用于清理监听器/定时器 */
  onUnmount?: () => void
}

/** 内置槽位（应用壳已定义，可扩展新槽位） */
export const PLUGIN_SLOTS = ['sidebar', 'content', 'statusbar'] as const
export type PluginSlot = (typeof PLUGIN_SLOTS)[number]
