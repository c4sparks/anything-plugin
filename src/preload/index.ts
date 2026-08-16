import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, type AppInfo } from '@shared/ipc'
import type { PluginFileEntry } from '@shared/ipc'
import type { AppSettings, SettingsPatch } from '@shared/settings'
import type { PluginDetail, PluginInfo } from '@shared/plugins'
import type { MarketSearchResult } from '@shared/market'
import type { AgentState, BoundsRect, UpdateInfo, UpgradeState } from '@shared/agent'

/**
 * 暴露给渲染进程的白名单 API。
 * 新增能力时在此声明方法，并在 index.d.ts 同步类型。
 */
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke(IPC.PING),
  plugins: {
    list: (): Promise<PluginInfo[]> => ipcRenderer.invoke(IPC.PLUGINS_LIST),
    load: (id: string): Promise<string> => ipcRenderer.invoke(IPC.PLUGINS_LOAD, id),
    rescan: (): Promise<PluginInfo[]> => ipcRenderer.invoke(IPC.PLUGINS_RESCAN),
    detail: (id: string): Promise<PluginDetail | null> =>
      ipcRenderer.invoke(IPC.PLUGINS_DETAIL, id),
    uninstall: (id: string, clearData?: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.PLUGINS_UNINSTALL, id, clearData === true),
    importLocal: (): Promise<boolean> => ipcRenderer.invoke(IPC.PLUGINS_IMPORT_LOCAL),
    /** 订阅插件目录变化（主进程推送），返回取消订阅函数 */
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.PLUGINS_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.PLUGINS_CHANGED, listener)
    },
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: SettingsPatch): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  },
  /** 插件数据（契约见 docs/插件契约.md §5）：userData/plugin-data/<id>/data.json */
  pluginData: {
    get: (id: string, key: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.PLUGIN_DATA_GET, id, key),
    set: (id: string, key: string, value: string): Promise<void> =>
      ipcRenderer.invoke(IPC.PLUGIN_DATA_SET, id, key, value),
    remove: (id: string, key: string): Promise<void> =>
      ipcRenderer.invoke(IPC.PLUGIN_DATA_REMOVE, id, key),
    clear: (id: string): Promise<void> => ipcRenderer.invoke(IPC.PLUGIN_DATA_CLEAR, id),
  },
  /** 插件文件存储（契约见 docs/插件契约.md §6）：userData/plugin-data/<id>/files/ */
  pluginFiles: {
    read: (id: string, relPath: string): Promise<string> =>
      ipcRenderer.invoke(IPC.PLUGIN_FILES_READ, id, relPath),
    write: (id: string, relPath: string, content: string): Promise<void> =>
      ipcRenderer.invoke(IPC.PLUGIN_FILES_WRITE, id, relPath, content),
    list: (id: string, dirRel?: string): Promise<PluginFileEntry[]> =>
      ipcRenderer.invoke(IPC.PLUGIN_FILES_LIST, id, dirRel),
    remove: (id: string, relPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.PLUGIN_FILES_REMOVE, id, relPath),
    mkdir: (id: string, relPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.PLUGIN_FILES_MKDIR, id, relPath),
    copy: (id: string, from: string, to: string): Promise<void> =>
      ipcRenderer.invoke(IPC.PLUGIN_FILES_COPY, id, from, to),
    move: (id: string, from: string, to: string): Promise<void> =>
      ipcRenderer.invoke(IPC.PLUGIN_FILES_MOVE, id, from, to),
  },
  market: {
    search: (q: string): Promise<MarketSearchResult> => ipcRenderer.invoke(IPC.MARKET_SEARCH, q),
    install: (id: string): Promise<void> => ipcRenderer.invoke(IPC.MARKET_INSTALL, id),
  },
  /** Agent 相关：所有方法按宿主应用插件 id 路由（多宿主） */
  agent: {
    start: (id: string): Promise<AgentState> => ipcRenderer.invoke(IPC.AGENT_START, id),
    stop: (id: string): Promise<AgentState> => ipcRenderer.invoke(IPC.AGENT_STOP, id),
    getState: (id: string): Promise<AgentState> => ipcRenderer.invoke(IPC.AGENT_GET_STATE, id),
    setBounds: (id: string, rect: BoundsRect): Promise<void> =>
      ipcRenderer.invoke(IPC.AGENT_SET_BOUNDS, id, rect),
    setVisible: (id: string, v: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.AGENT_SET_VISIBLE, id, v),
    /** 订阅宿主应用状态变化（payload {id, state}），返回取消订阅函数 */
    onStateChanged: (cb: (id: string, s: AgentState) => void): (() => void) => {
      const listener = (_: unknown, payload: { id: string; state: AgentState }): void =>
        cb(payload.id, payload.state)
      ipcRenderer.on(IPC.AGENT_STATE_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.AGENT_STATE_CHANGED, listener)
    },
    /** 检查 npm 新版本（registry 对比） */
    checkUpdate: (id: string): Promise<UpdateInfo> =>
      ipcRenderer.invoke(IPC.AGENT_CHECK_UPDATE, id),
    /** 升级（长任务，进度经 onUpgradeState 推送） */
    upgrade: (id: string, version: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.AGENT_UPGRADE, id, version),
    /** 卸载宿主应用（停进程 + 清数据/运行时；内置 dsh 置 agentInstalled=false，外部删插件目录） */
    uninstall: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.AGENT_UNINSTALL, id),
    /** 订阅升级进度（payload {id, state}），返回取消订阅函数 */
    onUpgradeState: (cb: (id: string, s: UpgradeState) => void): (() => void) => {
      const listener = (_: unknown, payload: { id: string; state: UpgradeState }): void =>
        cb(payload.id, payload.state)
      ipcRenderer.on(IPC.AGENT_UPGRADE_STATE, listener)
      return () => ipcRenderer.removeListener(IPC.AGENT_UPGRADE_STATE, listener)
    },
  },
  /** 应用信息（自绘标题栏：应用图标） */
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.APP_INFO),
  },
  /** 窗口控制（自绘标题栏右侧按钮） */
  window: {
    minimize: (): void => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    toggleMaximize: (): void => ipcRenderer.send(IPC.WINDOW_MAXIMIZE_TOGGLE),
    close: (): void => ipcRenderer.send(IPC.WINDOW_CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED),
    /** 订阅最大化状态变化，返回取消订阅函数 */
    onMaximizedChanged: (cb: (v: boolean) => void): (() => void) => {
      const listener = (_: unknown, v: boolean): void => cb(v)
      ipcRenderer.on(IPC.WINDOW_MAXIMIZED_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZED_CHANGED, listener)
    },
  },
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // node 项目不包含 DOM 全局 Window 扩展，此处挂载类型以 src/preload/index.d.ts 为准
  // @ts-expect-error (define in `src/preload/index.d.ts`)
  window.electron = electronAPI
  // @ts-expect-error (define in `src/preload/index.d.ts`)
  window.api = api
}
