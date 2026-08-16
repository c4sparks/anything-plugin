/**
 * 外部插件共享类型（主进程扫描 / 渲染层加载共用）。
 * 注意：enabled 是运行时状态，由主进程从 settings 合并，**不写入 manifest**
 * —— 避免第三方插件伪造该字段。
 */

/** 插件种类：webComponent（Web Component 挂槽位）/ hostApp（外部宿主应用侧车） */
export type PluginKind = 'webComponent' | 'hostApp'

/** 外部插件 manifest 字段约束（主进程强校验，见 src/main/plugins.ts） */
export interface ExternalPluginManifest {
  /** 全局唯一标识，^[a-z][a-z0-9_-]{0,63}$ */
  id: string
  /** 展示名 */
  name: string
  /** 插件种类（缺省 webComponent；hostApp 时无 tag/entry，须带 hostApp 定义） */
  kind?: PluginKind
  version?: string
  description?: string
  /** 发布者标识（可选；官方插件取 OFFICIAL_PUBLISHER，第三方留空则不展示） */
  publisher?: string
  /** 侧栏短名（hostApp 用） */
  shortName?: string
  /** hostApp 专用：AppIcon 命名图标（缺省通用 plugin 图标） */
  iconName?: string
  /** 自定义元素标签，^app-plugin-[a-z0-9-]+$（仅 webComponent） */
  tag?: string
  /** 挂载槽位：sidebar | content | statusbar */
  slot: string
  /** 同槽位排序权重 */
  order?: number
  /** 入口文件，相对路径，.js/.mjs（仅 webComponent） */
  entry?: string
  /** hostApp 定义（kind==='hostApp' 时必填，主进程强校验） */
  hostApp?: import('./hostApp').HostAppManifest
  /** 图标：manifest 中为相对路径（.svg/.png）；list 返回时主进程读取并转为 data URL */
  icon?: string
  /** 详情扩展字段（可选，详情页展示；主进程强校验） */
  homepage?: string
  repository?: string
  license?: string
  tags?: string[]
  categories?: string[]
  dependencies?: string[]
}

/** plugins:list / rescan 返回：manifest + enabled（由主进程合并 settings 偏好） */
export interface PluginInfo extends ExternalPluginManifest {
  enabled: boolean
}

/** plugins:detail 返回：完整 manifest + README/CHANGELOG（详情页用） */
export interface PluginDetail extends PluginInfo {
  /** 插件目录 README.md（UTF-8，≤64KB，超限截断） */
  readme?: string
  /** 可选 CHANGELOG.md（UTF-8，≤64KB） */
  changelog?: string
}

/** 插件 id 合法格式 */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/
/** 自定义元素标签合法格式（统一前缀 app-plugin-，且必含连字符） */
export const PLUGIN_TAG_RE = /^app-plugin-[a-z0-9-]+$/
/** 合法入口扩展名 */
export const PLUGIN_ENTRY_EXT = ['.js', '.mjs']
/** 已知槽位集 */
export const PLUGIN_SLOTS = ['sidebar', 'content', 'statusbar'] as const

/**
 * 官方插件发布者标识（应用自身提供的插件）——manifest 的 publisher 字段取此值。
 * 当前 UI 暂不展示 publisher 字段，保留常量作为官方插件的发布者约定。
 */
export const OFFICIAL_PUBLISHER = 'AnythingPlugin'
