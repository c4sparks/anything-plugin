import type { ElectronAPI } from '@electron-toolkit/preload'
import type { AppInfo } from '@shared/ipc'
import type { PluginFileEntry } from '@shared/ipc'
import type { AppSettings, SettingsPatch } from '@shared/settings'
import type { PluginDetail, PluginInfo } from '@shared/plugins'
import type { MarketSearchResult } from '@shared/market'
import type { AgentState, BoundsRect, UpdateInfo, UpgradeState } from '@shared/agent'

/** preload 暴露的 window.api 类型，与 src/preload/index.ts 保持同步 */
export interface Api {
  ping: () => Promise<string>
  plugins: {
    list: () => Promise<PluginInfo[]>
    load: (id: string) => Promise<string>
    detail: (id: string) => Promise<PluginDetail | null>
    rescan: () => Promise<PluginInfo[]>
    uninstall: (id: string, clearData?: boolean) => Promise<void>
    importLocal: () => Promise<boolean>
    onChanged: (cb: () => void) => () => void
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (patch: SettingsPatch) => Promise<AppSettings>
  }
  pluginData: {
    get: (id: string, key: string) => Promise<string | null>
    set: (id: string, key: string, value: string) => Promise<void>
    remove: (id: string, key: string) => Promise<void>
    clear: (id: string) => Promise<void>
  }
  pluginFiles: {
    read: (id: string, relPath: string) => Promise<string>
    write: (id: string, relPath: string, content: string) => Promise<void>
    list: (id: string, dirRel?: string) => Promise<PluginFileEntry[]>
    remove: (id: string, relPath: string) => Promise<void>
    mkdir: (id: string, relPath: string) => Promise<void>
    copy: (id: string, from: string, to: string) => Promise<void>
    move: (id: string, from: string, to: string) => Promise<void>
  }
  market: {
    search: (q: string) => Promise<MarketSearchResult>
    install: (id: string) => Promise<void>
  }
  agent: {
    start: (id: string) => Promise<AgentState>
    stop: (id: string) => Promise<AgentState>
    getState: (id: string) => Promise<AgentState>
    setBounds: (id: string, rect: BoundsRect) => Promise<void>
    setVisible: (id: string, v: boolean) => Promise<void>
    onStateChanged: (cb: (id: string, s: AgentState) => void) => () => void
    checkUpdate: (id: string) => Promise<UpdateInfo>
    upgrade: (id: string, version: string) => Promise<boolean>
    onUpgradeState: (cb: (id: string, s: UpgradeState) => void) => () => void
    uninstall: (id: string) => Promise<boolean>
  }
  app: {
    info: () => Promise<AppInfo>
  }
  window: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    onMaximizedChanged: (cb: (v: boolean) => void) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
