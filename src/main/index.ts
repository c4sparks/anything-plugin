import { app, shell, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC, type AppInfo } from '@shared/ipc'
import type { SettingsPatch } from '@shared/settings'
import { installMarketPlugin, searchMarket } from './marketplace'
import {
  getPluginDetail,
  importLocalPlugin,
  listPlugins,
  loadPluginScript,
  uninstallPlugin,
  watchPluginDir,
} from './plugins'
import { getSettings, updateSettings } from './settings'
import { clearPluginData, getPluginData, removePluginData, setPluginData } from './pluginData'
import {
  listPluginFiles,
  mkPluginDir,
  copyPluginFile,
  movePluginFile,
  readPluginFile,
  removePluginFile,
  writePluginFile,
} from './pluginFiles'
import { AgentManager } from './agent'
import type { BoundsRect } from '@shared/agent'
import { compileHostAppDef, DSH_HOST_APP, type HostAppIcon } from '@shared/hostApp'

// 钉死 userData 路径（app.name 默认取 package.json name，防 productName 变更漂移）
app.setName('anythingplugin')

let mainWindow: BrowserWindow | null = null
/** 宿主应用 AgentManager 注册表（key = hostApp 插件 id；内置 dsh 为种子条目） */
const agents = new Map<string, AgentManager>()

// 单实例锁：重复启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

/** 应用图标：Windows 用多尺寸 icon.ico（标题栏/任务栏各尺寸清晰），其它平台用 icon.png；
 *  dev 读工程 build/（buildResources 约定目录），打包读 extraResources 部署到 resources 根 */
function appIconPath(): string {
  const base = app.isPackaged ? process.resourcesPath : join(__dirname, '../../build')
  return process.platform === 'win32' ? join(base, 'icon.ico') : join(base, 'icon.png')
}

/** 应用图标 PNG 路径（标题栏内嵌等场景，始终读 PNG 而非 .ico） */
function appIconPngPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
    // 无边框：渲染层自绘 44px 标题栏（docs/设计规范.md §3），含应用图标 + 窗口控制按钮
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f4f6',
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  })

  // 最大化状态 → 渲染层（标题栏最大化/还原按钮图标）
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send(IPC.WINDOW_MAXIMIZED_CHANGED, true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send(IPC.WINDOW_MAXIMIZED_CHANGED, false)
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 外链交给系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // dev 走 Vite Dev Server（支持 HMR），生产加载打包产物
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** IPC 加固：仅接受主窗口自身 webContents 的调用 */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('非法 IPC 来源')
  }
}

// ---- IPC 处理器 ----
// 示例 IPC：渲染进程 ping → 主进程回 pong
ipcMain.handle(IPC.PING, () => 'pong')

ipcMain.handle(IPC.PLUGINS_LIST, (event) => {
  assertTrustedSender(event)
  return listPlugins()
})

ipcMain.handle(IPC.PLUGINS_LOAD, (event, id: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  return loadPluginScript(id)
})

ipcMain.handle(IPC.PLUGINS_DETAIL, (event, id: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  return getPluginDetail(id)
})

ipcMain.handle(IPC.PLUGINS_RESCAN, (event) => {
  assertTrustedSender(event)
  return listPlugins()
})

ipcMain.handle(IPC.PLUGINS_UNINSTALL, (event, id: unknown, clearData: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (clearData !== undefined && typeof clearData !== 'boolean') {
    throw new Error('clearData 必须是布尔值')
  }
  return uninstallPlugin(id, clearData === true)
})

ipcMain.handle(IPC.PLUGINS_IMPORT_LOCAL, (event) => {
  assertTrustedSender(event)
  return importLocalPlugin(BrowserWindow.fromWebContents(event.sender))
})

ipcMain.handle(IPC.MARKET_SEARCH, (event, q: unknown) => {
  assertTrustedSender(event)
  return searchMarket(typeof q === 'string' ? q : '')
})

ipcMain.handle(IPC.MARKET_INSTALL, (event, id: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  return installMarketPlugin(id)
})

ipcMain.handle(IPC.SETTINGS_GET, (event) => {
  assertTrustedSender(event)
  return getSettings()
})

ipcMain.handle(IPC.SETTINGS_SET, (event, patch: SettingsPatch) => {
  assertTrustedSender(event)
  return updateSettings(patch)
})

// ---- 插件数据（契约见 docs/插件契约.md §5）----
ipcMain.handle(IPC.PLUGIN_DATA_GET, (event, id: unknown, key: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (typeof key !== 'string') throw new Error('无效的数据 key')
  return getPluginData(id, key)
})

ipcMain.handle(IPC.PLUGIN_DATA_SET, (event, id: unknown, key: unknown, value: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (typeof key !== 'string') throw new Error('无效的数据 key')
  if (typeof value !== 'string') throw new Error('数据值必须是字符串')
  return setPluginData(id, key, value)
})

ipcMain.handle(IPC.PLUGIN_DATA_REMOVE, (event, id: unknown, key: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (typeof key !== 'string') throw new Error('无效的数据 key')
  return removePluginData(id, key)
})

ipcMain.handle(IPC.PLUGIN_DATA_CLEAR, (event, id: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  return clearPluginData(id)
})

// ---- 插件文件存储（契约见 docs/插件契约.md §6）----
ipcMain.handle(IPC.PLUGIN_FILES_READ, (event, id: unknown, relPath: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (typeof relPath !== 'string') throw new Error('无效的文件路径')
  return readPluginFile(id, relPath)
})

ipcMain.handle(IPC.PLUGIN_FILES_WRITE, (event, id: unknown, relPath: unknown, content: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (typeof relPath !== 'string') throw new Error('无效的文件路径')
  if (typeof content !== 'string') throw new Error('文件内容必须是字符串')
  return writePluginFile(id, relPath, content)
})

ipcMain.handle(IPC.PLUGIN_FILES_LIST, (event, id: unknown, dirRel: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (dirRel !== undefined && typeof dirRel !== 'string') throw new Error('无效的目录路径')
  return listPluginFiles(id, dirRel as string | undefined)
})

ipcMain.handle(IPC.PLUGIN_FILES_REMOVE, (event, id: unknown, relPath: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (typeof relPath !== 'string') throw new Error('无效的文件路径')
  return removePluginFile(id, relPath)
})

ipcMain.handle(IPC.PLUGIN_FILES_MKDIR, (event, id: unknown, relPath: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (typeof relPath !== 'string') throw new Error('无效的目录路径')
  return mkPluginDir(id, relPath)
})

ipcMain.handle(IPC.PLUGIN_FILES_COPY, (event, id: unknown, from: unknown, to: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (typeof from !== 'string' || typeof to !== 'string') throw new Error('无效的文件路径')
  return copyPluginFile(id, from, to)
})

ipcMain.handle(IPC.PLUGIN_FILES_MOVE, (event, id: unknown, from: unknown, to: unknown) => {
  assertTrustedSender(event)
  if (typeof id !== 'string') throw new Error('无效的插件 id')
  if (typeof from !== 'string' || typeof to !== 'string') throw new Error('无效的文件路径')
  return movePluginFile(id, from, to)
})

/** 校验渲染层上报的内容区边界（数字、非负） */
function validateBounds(v: unknown): BoundsRect {
  if (!v || typeof v !== 'object') throw new Error('无效的边界')
  const r = v as Record<string, unknown>
  const num = (k: string): number =>
    typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : NaN
  const x = num('x')
  const y = num('y')
  const width = num('width')
  const height = num('height')
  if (
    Number.isNaN(x) ||
    Number.isNaN(y) ||
    Number.isNaN(width) ||
    Number.isNaN(height) ||
    width < 0 ||
    height < 0
  ) {
    throw new Error('无效的边界')
  }
  return { x, y, width, height }
}

/** 从 IPC 取 AgentManager（校验来源 + id 存在） */
function getAgent(
  event: IpcMainInvokeEvent,
  id: unknown,
  agents: Map<string, AgentManager>,
): AgentManager {
  assertTrustedSender(event)
  if (typeof id !== 'string' || !agents.has(id)) throw new Error('未找到宿主应用')
  return agents.get(id)!
}

/** Agent 相关 IPC（按 id 路由到对应 AgentManager） */
function registerAgentIpc(agents: Map<string, AgentManager>): void {
  ipcMain.handle(IPC.AGENT_START, (event, id) => getAgent(event, id, agents).start())
  ipcMain.handle(IPC.AGENT_STOP, (event, id) => getAgent(event, id, agents).stop())
  ipcMain.handle(IPC.AGENT_GET_STATE, (event, id) => getAgent(event, id, agents).state)
  ipcMain.handle(IPC.AGENT_SET_BOUNDS, (event, id, rect: unknown) =>
    getAgent(event, id, agents).setBounds(validateBounds(rect)),
  )
  ipcMain.handle(IPC.AGENT_SET_VISIBLE, (event, id, v: unknown) =>
    getAgent(event, id, agents).setVisible(v === true),
  )
  ipcMain.handle(IPC.AGENT_CHECK_UPDATE, (event, id) => getAgent(event, id, agents).checkUpdate())
  ipcMain.handle(IPC.AGENT_UPGRADE, (event, id, version: unknown) => {
    const m = getAgent(event, id, agents)
    if (typeof version !== 'string' || !version) throw new Error('无效的版本')
    // 升级是长任务：fire-and-forget，进度经 agent:upgradeState 推送
    void m.upgrade(version)
    return true
  })
  ipcMain.handle(IPC.AGENT_UNINSTALL, async (event, id) => {
    const m = getAgent(event, id, agents)
    await m.uninstall() // 停进程 + 清数据/运行时
    if (id === DSH_HOST_APP.id) {
      // 内置 dsh：agentInstalled=false → 渲染层隐藏 + 插件页显示重装入口
      await updateSettings({ agentInstalled: false })
    } else {
      // 外部 hostApp：删插件目录 → fs.watch 重扫 → syncHostAppAgents 移除该 AgentManager
      await uninstallPlugin(id)
    }
    return true
  })
}

/** 窗口控制 + 应用信息 IPC（自绘标题栏：左侧图标 + 右侧窗口按钮） */
function registerWindowIpc(): void {
  ipcMain.on(IPC.WINDOW_MINIMIZE, (event) => {
    if (event.sender === mainWindow?.webContents) mainWindow?.minimize()
  })
  ipcMain.on(IPC.WINDOW_MAXIMIZE_TOGGLE, (event) => {
    if (event.sender !== mainWindow?.webContents) return
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on(IPC.WINDOW_CLOSE, (event) => {
    if (event.sender === mainWindow?.webContents) mainWindow?.close()
  })
  ipcMain.handle(IPC.WINDOW_IS_MAXIMIZED, (event) => {
    assertTrustedSender(event)
    return mainWindow?.isMaximized() ?? false
  })
  ipcMain.handle(IPC.APP_INFO, async (event): Promise<AppInfo> => {
    assertTrustedSender(event)
    const icon = await readFile(appIconPngPath())
    return {
      version: app.getVersion(),
      iconDataUrl: `data:image/png;base64,${icon.toString('base64')}`,
      userDataPath: app.getPath('userData'),
    }
  })
}

/** 同步宿主应用 AgentManager 注册表：内置 dsh 种子 + 外部 hostApp 建实例，删除的销毁 */
async function syncHostAppAgents(): Promise<void> {
  if (!agents.has(DSH_HOST_APP.id)) {
    agents.set(DSH_HOST_APP.id, new AgentManager(DSH_HOST_APP, () => mainWindow))
  }
  const ids = new Set<string>([DSH_HOST_APP.id])
  const infos = await listPlugins()
  for (const info of infos) {
    if (info.kind !== 'hostApp' || !info.hostApp) continue
    ids.add(info.id)
    if (!agents.has(info.id)) {
      const def = compileHostAppDef(info.hostApp, {
        id: info.id,
        name: info.name,
        shortName: info.shortName,
        icon: (info.iconName as HostAppIcon | undefined) ?? 'plugin',
        description: info.description,
      })
      agents.set(info.id, new AgentManager(def, () => mainWindow))
    }
  }
  for (const [id, m] of agents) {
    if (!ids.has(id)) {
      m.destroy()
      agents.delete(id)
    }
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.anything.app')

  // 开发模式下监听 F12/Ctrl+R 等快捷键
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // 宿主应用 AgentManager 注册表：内置 dsh 种子 + 外部 hostApp 建实例
  void syncHostAppAgents()
  registerAgentIpc(agents)
  registerWindowIpc()

  // 监听插件目录：新装/卸载/改动 → 推送渲染层自动重扫 + 同步宿主应用实例
  void watchPluginDir(() => {
    void syncHostAppAgents()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.PLUGINS_CHANGED)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  for (const m of agents.values()) m.destroy()
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
