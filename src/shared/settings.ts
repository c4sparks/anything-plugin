/**
 * 应用设置（主进程持久化到 userData/settings.json，渲染层经 window.api.settings 读写）。
 */
export interface AppSettings {
  /** 结构版本，为将来迁移留位 */
  version: 1
  theme: 'light' | 'dark'
  /** 被禁用的插件 id 集合（enabled 状态唯一持久化来源） */
  disabledPlugins: string[]
  /** 侧栏是否折叠为纯图标栏 */
  sidebarCollapsed: boolean
  /** 安全模式：第三方插件使用前必须开启（沙箱隔离运行的前提） */
  safeMode: boolean
  /** 宿主应用（dsh Agent）是否已安装（卸载 = false，插件从列表消失，可在插件页重新安装） */
  agentInstalled: boolean
}

/** settings:set 接受的部分字段（白名单在 src/main/settings.ts 强校验） */
export type SettingsPatch = Partial<
  Pick<AppSettings, 'theme' | 'disabledPlugins' | 'sidebarCollapsed' | 'safeMode' | 'agentInstalled'>
>
