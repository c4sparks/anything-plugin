/**
 * 主进程 / 渲染进程共用的 IPC 通道常量。
 * 新增通道流程：在此定义 → 主进程 ipcMain.handle → preload 暴露 → 渲染层调用。
 */
export const IPC = {
  PING: 'app:ping',
  /** 列出外部插件（manifest + enabled） */
  PLUGINS_LIST: 'plugins:list',
  /** 按插件 id 读取 entry 源码（只认 id，主进程从扫描缓存解析路径） */
  PLUGINS_LOAD: 'plugins:load',
  /** 重新扫描插件目录，返回最新列表 */
  PLUGINS_RESCAN: 'plugins:rescan',
  /** 插件详情：完整 manifest + README/CHANGELOG（详情页用） */
  PLUGINS_DETAIL: 'plugins:detail',
  /** 卸载插件（只允许删除插件根目录的直接子目录） */
  PLUGINS_UNINSTALL: 'plugins:uninstall',
  /** 手动导入：文件对话框选 zip → 校验解压进插件目录 */
  PLUGINS_IMPORT_LOCAL: 'plugins:importLocal',
  /** 市场搜索（拉取注册表并按关键词过滤） */
  MARKET_SEARCH: 'market:search',
  /** 市场安装（下载 zip → sha256 校验 → 解压进插件目录） */
  MARKET_INSTALL: 'market:install',
  /** 插件数据：读取（id + key → string | null） */
  PLUGIN_DATA_GET: 'plugin-data:get',
  /** 插件数据：写入（id + key + value，原子持久化） */
  PLUGIN_DATA_SET: 'plugin-data:set',
  /** 插件数据：删除单个 key（不存在幂等） */
  PLUGIN_DATA_REMOVE: 'plugin-data:remove',
  /** 插件数据：清空整个插件数据目录 */
  PLUGIN_DATA_CLEAR: 'plugin-data:clear',
  /** 插件文件：读取（id + 相对路径 → UTF-8 文本） */
  PLUGIN_FILES_READ: 'plugin-files:read',
  /** 插件文件：写入（id + 相对路径 + 内容，原子写，自动建父目录） */
  PLUGIN_FILES_WRITE: 'plugin-files:write',
  /** 插件文件：列目录（id + 可选相对目录 → FileEntry[]） */
  PLUGIN_FILES_LIST: 'plugin-files:list',
  /** 插件文件：删除（文件/文件夹递归，仅限插件文件根内） */
  PLUGIN_FILES_REMOVE: 'plugin-files:remove',
  /** 插件文件：建文件夹 */
  PLUGIN_FILES_MKDIR: 'plugin-files:mkdir',
  /** 插件文件：复制（文件/文件夹递归，目标已存在报错） */
  PLUGIN_FILES_COPY: 'plugin-files:copy',
  /** 插件文件：移动/重命名（文件/文件夹递归，跨盘 fallback 复制+删除） */
  PLUGIN_FILES_MOVE: 'plugin-files:move',
  /** 主进程 → 渲染层推送：插件目录变化（新装/卸载/改动），渲染层据此自动重扫 */
  PLUGINS_CHANGED: 'plugins:changed',
  /** 读取设置 */
  SETTINGS_GET: 'settings:get',
  /** 合并更新设置（白名单字段）并持久化 */
  SETTINGS_SET: 'settings:set',
  /** Agent：启动 sidecar host */
  AGENT_START: 'agent:start',
  /** Agent：停止 sidecar host */
  AGENT_STOP: 'agent:stop',
  /** Agent：读取当前状态 */
  AGENT_GET_STATE: 'agent:getState',
  /** Agent：设置 WebContentsView 边界（renderer 上报内容区几何） */
  AGENT_SET_BOUNDS: 'agent:setBounds',
  /** Agent：显示/隐藏视图 */
  AGENT_SET_VISIBLE: 'agent:setVisible',
  /** Agent：主进程 → 渲染层推送状态变化 */
  AGENT_STATE_CHANGED: 'agent:stateChanged',
  /** Agent：检查 dsh 新版本（npm registry 对比） */
  AGENT_CHECK_UPDATE: 'agent:checkUpdate',
  /** Agent：升级 dsh（npm install 到运行时目录） */
  AGENT_UPGRADE: 'agent:upgrade',
  /** Agent：主进程 → 渲染层推送升级进度 */
  AGENT_UPGRADE_STATE: 'agent:upgradeState',
  /** Agent：卸载（停进程 + 清数据/运行时目录） */
  AGENT_UNINSTALL: 'agent:uninstall',
  /** 窗口控制：最小化 */
  WINDOW_MINIMIZE: 'window:minimize',
  /** 窗口控制：最大化/还原 */
  WINDOW_MAXIMIZE_TOGGLE: 'window:maximizeToggle',
  /** 窗口控制：关闭 */
  WINDOW_CLOSE: 'window:close',
  /** 查询窗口是否最大化 */
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  /** 主进程 → 渲染层推送：窗口最大化状态变化（boolean） */
  WINDOW_MAXIMIZED_CHANGED: 'window:maximizedChanged',
  /** 应用信息：版本 + 应用图标 data URL（标题栏显示用） */
  APP_INFO: 'app:info',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** app:info 返回的应用信息（标题栏：版本 + 应用图标） */
export interface AppInfo {
  version: string
  iconDataUrl: string
  /** 用户数据目录（userData，设置/插件/plugin-data 所在） */
  userDataPath: string
}

/** plugin-files 列目录返回的条目 */
export interface PluginFileEntry {
  name: string
  /** 相对插件文件根的路径（如 `a/b.md`、`folder`） */
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
  /** 创建时间（stat.birthtimeMs） */
  createdMs: number
}
