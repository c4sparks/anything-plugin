import { reactive } from 'vue'
import type { AppSettings } from '@shared/settings'
import type { PluginInfo } from '@shared/plugins'
import type { MarketSearchResult } from '@shared/market'
import type { AgentState, UpdateInfo, UpgradeState } from '@shared/agent'
import { getPlugins, unregisterPlugin } from '../plugins/registry'
import { loadExternalPlugins } from '../plugins/loader'
import type { PluginItem } from '../plugins/types'
import { DSH_HOST_APP } from '@shared/hostApp'

export type ShellView =
  | { type: 'page'; id: 'home' | 'plugins' | 'settings' }
  | { type: 'plugin'; id: string }
  | { type: 'detail'; id: string }

/**
 * 壳层反应式状态（数据源单一）：UI 一律从这里读插件列表与导航状态。
 * registry 的 Map 非响应式，因此插件元数据在此合并成 pluginItems。
 */
export const store = reactive({
  currentView: { type: 'page', id: 'home' } as ShellView,
  settings: {
    version: 1,
    theme: 'light',
    disabledPlugins: [],
    sidebarCollapsed: false,
    safeMode: false,
    agentInstalled: true,
  } as AppSettings,
  pluginItems: [] as PluginItem[],
  /** 外部插件原始清单（来自 IPC，含 enabled） */
  externalInfos: [] as PluginInfo[],
  /** 外部插件条目（带加载状态），与注册表合并展示 */
  externalItems: [] as PluginItem[],
  /** 插件管理页聚焦高亮的插件 id（点侧栏插件项时设置） */
  pluginFocusId: null as string | null,
  /** 各宿主应用（hostApp 插件）运行时状态，key = 插件 id */
  agentStates: {} as Record<string, AgentState>,
  /** 各宿主应用版本检查结果（key = 插件 id） */
  updateInfos: {} as Record<string, UpdateInfo>,
  /** 各宿主应用版本检查进行中（key = 插件 id） */
  checkingIds: {} as Record<string, boolean>,
  /** 各宿主应用升级进度（key = 插件 id） */
  upgradeStates: {} as Record<string, UpgradeState>,
  ready: false,

  // ---- 派生选择器 ----
  /** 插件是否可用：内置始终可用；第三方需「已启用 && 未开启安全模式」（安全模式=隐藏禁用第三方） */
  pluginUsable(p: PluginItem): boolean {
    return p.enabled && (p.tier === 'trusted' || !this.settings.safeMode)
  },
  pluginsForSlot(slot: string): PluginItem[] {
    return this.pluginItems.filter((p) => p.slot === slot && this.pluginUsable(p))
  },
  contentPlugins(): PluginItem[] {
    return this.pluginsForSlot('content')
  },
  pluginTag(id: string): string {
    return this.pluginItems.find((p) => p.id === id)?.tag ?? ''
  },
  isPageActive(id: 'home' | 'plugins' | 'settings'): boolean {
    return this.currentView.type === 'page' && this.currentView.id === id
  },
  isPluginActive(id: string): boolean {
    return this.currentView.type === 'plugin' && this.currentView.id === id
  },

  // ---- 导航 ----
  navigatePage(id: 'home' | 'plugins' | 'settings'): void {
    this.currentView = { type: 'page', id }
  },
  navigatePlugin(id: string): void {
    const p = this.pluginItems.find((it) => it.id === id)
    if (!p) return
    // 安全模式开启时第三方插件不可访问（已隐藏）
    if (p.tier === 'thirdParty' && this.settings.safeMode) return
    if (!this.pluginUsable(p)) {
      this.currentView = { type: 'page', id: 'home' } // 已禁用/已卸载 → 回退首页
      return
    }
    this.currentView = { type: 'plugin', id }
    // hostApp 插件：打开即启动侧车；已就绪则立即显示视图
    if (p.kind === 'hostApp') {
      const s = this.agentStateOf(id)
      if (s.status !== 'ready' && s.status !== 'starting') void this.startAgent(id)
      else this.syncAgentVisible(id)
    }
  },
  /** 打开插件管理页；传 id 时聚焦高亮该插件（侧栏/首页点插件项的行为） */
  openPlugins(id?: string): void {
    this.pluginFocusId = id ?? null
    this.currentView = { type: 'page', id: 'plugins' }
  },
  /** 打开插件详情页（双击插件行） */
  openPluginDetail(id: string): void {
    this.currentView = { type: 'detail', id }
  },

  // ---- 宿主应用（hostApp 插件）----
  /** hostApp 插件条目列表 */
  hostAppItems(): PluginItem[] {
    return this.pluginItems.filter((p) => p.kind === 'hostApp')
  },
  /** 取宿主应用运行时状态（缺省 idle） */
  agentStateOf(id: string): AgentState {
    return this.agentStates[id] ?? { status: 'idle' }
  },
  isHostAppView(id: string): boolean {
    return this.currentView.type === 'plugin' && this.currentView.id === id
  },
  /** 启动侧车（幂等），并同步视图可见性 */
  async startAgent(id: string): Promise<void> {
    this.agentStates[id] = await window.api.agent.start(id)
    this.syncAgentVisible(id)
  },
  /** 停止侧车 */
  async stopAgent(id: string): Promise<void> {
    this.agentStates[id] = await window.api.agent.stop(id)
    this.syncAgentVisible(id)
  },
  /** 视图可见性 = 该 hostApp 插件视图激活 && 已就绪（就绪时 WebContentsView 覆盖内容区） */
  syncAgentVisible(id: string): void {
    void window.api.agent.setVisible(
      id,
      this.isHostAppView(id) && this.agentStateOf(id).status === 'ready',
    )
  },
  /** 检查 npm 新版本 */
  async checkAgentUpdate(id: string): Promise<void> {
    this.checkingIds[id] = true
    try {
      this.updateInfos[id] = await window.api.agent.checkUpdate(id)
    } finally {
      this.checkingIds[id] = false
    }
  },
  /** 升级（进度经 onUpgradeState 更新 upgradeStates） */
  async upgradeAgent(id: string, version: string): Promise<void> {
    this.upgradeStates[id] = { phase: 'installing', version }
    await window.api.agent.upgrade(id, version)
  },
  /** 卸载宿主应用：离开视图 → 停侧车 → 主进程处理（内置 dsh 置 agentInstalled，外部删目录）→ 重扫刷新 */
  async uninstallHostApp(id: string): Promise<void> {
    if (this.isHostAppView(id)) this.currentView = { type: 'page', id: 'home' }
    await this.stopAgent(id)
    await window.api.agent.uninstall(id)
    this.settings = await window.api.settings.get()
    await this.rescan()
    this.refresh()
  },
  /** 重新安装内置宿主应用（dsh）：agentInstalled=true + 移除禁用 → 插件回归 */
  async reinstallAgent(): Promise<void> {
    this.settings = await window.api.settings.set({
      agentInstalled: true,
      disabledPlugins: this.settings.disabledPlugins.filter((d) => d !== DSH_HOST_APP.id),
    })
    this.refresh()
  },

  // ---- 侧栏折叠 ----
  async toggleSidebar(): Promise<void> {
    this.settings = await window.api.settings.set({
      sidebarCollapsed: !this.settings.sidebarCollapsed,
    })
  },

  // ---- 主题 ----
  applyTheme(): void {
    document.documentElement.dataset.theme = this.settings.theme
    // Element Plus 深色类同步（docs/设计规范.md §10.1）
    document.documentElement.classList.toggle('dark', this.settings.theme === 'dark')
  },
  async setTheme(theme: 'light' | 'dark'): Promise<void> {
    this.settings = await window.api.settings.set({ theme })
    this.applyTheme()
  },

  // ---- 安全模式（保护模式：开启时隐藏并禁用第三方插件） ----
  async setSafeMode(v: boolean): Promise<void> {
    this.settings = await window.api.settings.set({ safeMode: v })
    this.refresh()
  },

  // ---- 插件启停 ----
  async togglePlugin(id: string): Promise<void> {
    const p = this.pluginItems.find((it) => it.id === id)
    if (!p) return
    // 安全模式开启时第三方插件不可启停（已隐藏）
    if (p.tier === 'thirdParty' && this.settings.safeMode) return
    const wasEnabled = !this.settings.disabledPlugins.includes(id)
    const next = wasEnabled
      ? [...this.settings.disabledPlugins, id]
      : this.settings.disabledPlugins.filter((d) => d !== id)
    this.settings = await window.api.settings.set({ disabledPlugins: next })

    // 刚启用：外部 webComponent 插件若尚未执行，需加载并注册（hostApp 无 tag，跳过）
    if (!wasEnabled) {
      const info = this.externalInfos.find((it) => it.id === id)
      if (info && info.kind !== 'hostApp' && info.tag && !customElements.get(info.tag)) {
        const reloaded = await loadExternalPlugins([{ ...info, enabled: true }])
        this.externalItems = this.externalItems.map((it) =>
          it.id === id ? (reloaded[0] ?? it) : it,
        )
      }
    }
    this.refresh()
    if (wasEnabled) {
      // 禁用运行中的 hostApp → 联动停止 sidecar
      const st = this.agentStateOf(id)
      if (p.kind === 'hostApp' && st.status !== 'idle' && st.status !== 'stopped') {
        await this.stopAgent(id)
      }
      // 禁用了当前正在展示的插件 → 回退首页
      if (this.currentView.type === 'plugin' && this.currentView.id === id) {
        this.currentView = { type: 'page', id: 'home' }
      }
    }
  },

  // ---- 重新扫描 ----
  async rescan(): Promise<void> {
    const infos = await window.api.plugins.rescan()
    // 注销已删除的外部插件
    const newIds = new Set(infos.map((i) => i.id))
    for (const it of this.externalItems) {
      if (!newIds.has(it.id)) unregisterPlugin(it.id)
    }
    this.externalInfos = infos
    this.externalItems = await loadExternalPlugins(infos)
    this.refresh()
    // 当前视图是已卸载插件 → 回退首页
    if (this.currentView.type === 'plugin' && !newIds.has(this.currentView.id)) {
      this.currentView = { type: 'page', id: 'home' }
    }
  },

  // ---- 卸载插件 ----
  async uninstallPlugin(id: string, clearData = false): Promise<void> {
    await window.api.plugins.uninstall(id, clearData)
    // 主进程已删除插件目录；fs.watch 会自动触发重扫，这里也主动重扫即时刷新
    await this.rescan()
  },

  // ---- 手动导入 ----
  async importLocal(): Promise<boolean> {
    const ok = await window.api.plugins.importLocal()
    if (ok) await this.rescan()
    return ok
  },

  // ---- 插件市场 ----
  searchMarket(q: string): Promise<MarketSearchResult> {
    return window.api.market.search(q)
  },
  async installMarketPlugin(id: string): Promise<void> {
    await window.api.market.install(id)
    await this.rescan()
  },

  // ---- 初始化 / 合并刷新 ----
  refresh(): void {
    const disabled = new Set(this.settings.disabledPlugins)
    const map = new Map<string, PluginItem>()
    for (const p of getPlugins()) {
      // 已卸载的内置 dsh 不出现在任何 UI（外部 hostApp 由目录存在性决定，不走此过滤）
      if (p.kind === 'hostApp' && p.id === DSH_HOST_APP.id && !this.settings.agentInstalled)
        continue
      map.set(p.id, { ...p, enabled: !disabled.has(p.id) })
    }
    for (const it of this.externalItems) {
      map.set(it.id, { ...(map.get(it.id) ?? it), ...it, enabled: !disabled.has(it.id) })
    }
    this.pluginItems = [...map.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  },

  async init(): Promise<void> {
    this.settings = await window.api.settings.get()
    this.applyTheme()
    // 宿主应用状态：先取当前值，再订阅后续变化（就绪后若仍在对应视图则显示）
    window.api.agent.onStateChanged((id, s) => {
      this.agentStates[id] = s
      this.syncAgentVisible(id)
    })
    window.api.agent.onUpgradeState((id, s) => {
      this.upgradeStates[id] = s
    })
    this.externalInfos = await window.api.plugins.list()
    this.externalItems = await loadExternalPlugins(this.externalInfos)
    this.refresh()
    // 各宿主应用拉取初始运行状态
    for (const p of this.hostAppItems()) {
      void window.api.agent.getState(p.id).then((s) => {
        this.agentStates[p.id] = s
      })
    }
    this.ready = true
    // 插件目录变化（新装/卸载/改动）→ 自动重扫，菜单自动增删刷新
    window.api.plugins.onChanged(() => {
      void this.rescan()
    })
  },
})
