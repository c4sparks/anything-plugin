import { app, shell, WebContentsView, type BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { AgentState, BoundsRect, UpdateInfo, UpgradeState } from '@shared/agent'
import type { HostAppDefinition } from '@shared/hostApp'
import { getPluginDir } from './plugins'

/**
 * Agent（外部宿主应用侧车）管理器，定义驱动、可插拔。
 * 由 HostAppDefinition 描述如何 spawn / 解析就绪 / 定位数据与运行时目录 / 检查升级。
 * 主进程不 import 宿主包（只拼路径字符串），视图不配 preload（无法碰 Electron API），
 * 导航护栏钉死 127.0.0.1，数据目录隔离到 userData。
 */
const READY_TIMEOUT = 30_000

/** npm registry（尊重本机 npm config，回退国内镜像源） */
const NPM_REGISTRY = process.env['npm_config_registry'] || 'https://registry.npmmirror.com'

/** 运行时安装根目录（版本隔离：<runtimeDir>/<version>/） */
function runtimeRoot(def: HostAppDefinition): string {
  return join(app.getPath('userData'), def.runtimeDir)
}

/** 记录当前生效版本的文件 */
function currentFile(def: HostAppDefinition): string {
  return join(runtimeRoot(def), 'current.json')
}

/** 数据目录（userData/<dataDir>），避免污染用户主目录 */
function dataHome(def: HostAppDefinition): string {
  return join(app.getPath('userData'), def.dataDir)
}

/** 当前生效版本：运行时 active（current.json）→ 应用 node_modules（dev） */
function currentVersion(def: HostAppDefinition): string {
  try {
    const cur = JSON.parse(readFileSync(currentFile(def), 'utf-8')) as { version?: string }
    if (cur.version) return cur.version
  } catch {
    /* 无运行时 active */
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(app.getAppPath(), 'node_modules', def.packageName, 'package.json'), 'utf-8'),
    ) as { version?: string }
    if (pkg.version) return pkg.version
  } catch {
    /* 未安装 */
  }
  return 'unknown'
}

/** 解析侧车要跑的 host bin：运行时目录 active 版本 → 打包侧车 → 应用 node_modules（dev） */
function resolveHostBin(def: HostAppDefinition): string {
  // 插件目录内本地宿主（hostDir 自包含模式，离线可用）：优先解析插件目录内代码
  if (def.hostDir != null) {
    const pluginDir = getPluginDir(def.id)
    if (pluginDir) {
      const local = join(pluginDir, def.hostDir, def.hostBin)
      if (existsSync(local)) return local
    }
  }
  try {
    const cur = JSON.parse(readFileSync(currentFile(def), 'utf-8')) as { version?: string }
    if (cur.version) {
      const p = join(runtimeRoot(def), cur.version, 'node_modules', def.packageName, def.hostBin)
      if (existsSync(p)) return p
    }
  } catch {
    /* 无运行时 active */
  }
  if (app.isPackaged) {
    const p = join(process.resourcesPath, 'dsh-host', 'app', 'node_modules', def.packageName, def.hostBin)
    if (existsSync(p)) return p
    throw new Error(`未找到 ${def.packageName} host bin（打包侧车缺失，请重新安装）`)
  }
  const dev = join(app.getAppPath(), 'node_modules', def.packageName, def.hostBin)
  if (existsSync(dev)) return dev
  throw new Error(`未找到 ${def.packageName} host bin，请先 pnpm install`)
}

/** 侧车 Node 运行时：dev 用系统 node（v22.20，与 npm/pnpm 原生依赖 ABI 一致）；打包用 resources/dsh-host/dsh-host.exe */
function resolveNodeBin(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'dsh-host', 'dsh-host.exe')
  return process.env['npm_node_execpath'] || 'node'
}

export class AgentManager {
  private child: ChildProcess | null = null
  private port = 0
  private expectedStop = false
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private loading = false
  private loadedUrl = ''
  private view: WebContentsView | null = null
  private latestBounds: BoundsRect | null = null
  private visible = false
  private _state: AgentState = { status: 'idle' }
  private readonly listeners = new Set<(s: AgentState) => void>()
  private readonly upgradeListeners = new Set<(s: UpgradeState) => void>()

  constructor(
    private readonly def: HostAppDefinition,
    private readonly getWindow: () => BrowserWindow | null,
  ) {}

  get state(): AgentState {
    return this._state
  }

  /** 订阅状态变化（渲染层推送 + 进程内监听两用） */
  onState(cb: (s: AgentState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private setState(s: AgentState): void {
    this._state = s
    const win = this.getWindow()
    if (win && !win.isDestroyed()) {
      // 多宿主：payload 带 id，渲染层按 id 路由
      win.webContents.send(IPC.AGENT_STATE_CHANGED, { id: this.def.id, state: s })
    }
    for (const l of this.listeners) l(s)
  }

  // ---- host 生命周期 ----

  async start(): Promise<AgentState> {
    if (this.child || this._state.status === 'ready') return this._state // 幂等
    this.expectedStop = false
    this.setState({ status: 'starting' })

    let bin: string
    try {
      bin = resolveHostBin(this.def)
    } catch (err) {
      this.setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      return this._state
    }

    const child = spawn(resolveNodeBin(), [bin, ...this.def.cliArgs], {
      env: {
        ...process.env,
        [this.def.dataHomeEnv]: dataHome(this.def),
        ...this.def.extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    let buf = ''
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString()
      const m = this.def.readyRe.exec(buf)
      if (m && !this.port) {
        this.port = Number(m[1])
        if (this.readyTimer) {
          clearTimeout(this.readyTimer)
          this.readyTimer = null
        }
        const url = `http://127.0.0.1:${this.port}`
        console.log('[agent] ready at', url)
        this.setState({ status: 'ready', port: this.port, url })
        // 不在此处加载视图：只由 setVisible(true)（用户打开 agent 页）触发，避免重复导航
      }
    })
    child.stderr.on('data', (c: Buffer) => console.error('[agent]', c.toString()))
    child.on('exit', (code, sig) => {
      this.child = null
      if (this.readyTimer) {
        clearTimeout(this.readyTimer)
        this.readyTimer = null
      }
      this.port = 0
      if (this.expectedStop) {
        this.setState({ status: 'stopped' })
      } else {
        this.setState({ status: 'error', error: `宿主应用意外退出（code=${code} sig=${sig}）` })
      }
    })

    this.readyTimer = setTimeout(() => {
      if (this._state.status === 'starting') {
        this.setState({ status: 'error', error: `等待就绪超时（${READY_TIMEOUT / 1000}s）` })
      }
    }, READY_TIMEOUT)

    return this._state
  }

  async stop(): Promise<AgentState> {
    this.expectedStop = true
    if (this.child) {
      this.child.kill()
    } else {
      this.setState({ status: 'stopped' })
    }
    this.setVisibleSync(false)
    return this._state
  }

  // ---- 版本检查与升级 ----

  /** 订阅升级进度（渲染层推送 + 进程内监听两用） */
  onUpgrade(cb: (s: UpgradeState) => void): () => void {
    this.upgradeListeners.add(cb)
    return () => this.upgradeListeners.delete(cb)
  }

  private pushUpgrade(s: UpgradeState): void {
    for (const l of this.upgradeListeners) l(s)
    const win = this.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.AGENT_UPGRADE_STATE, { id: this.def.id, state: s })
    }
  }

  /** 查 npm registry 最新版，与当前生效版本对比 */
  async checkUpdate(): Promise<UpdateInfo> {
    const current = currentVersion(this.def)
    try {
      const res = await fetch(`${NPM_REGISTRY}/${this.def.packageName}/latest`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        return { current, latest: null, hasUpdate: false, error: `HTTP ${res.status}` }
      }
      const data = (await res.json()) as { version?: string }
      const latest = typeof data.version === 'string' && data.version ? data.version : null
      return {
        current,
        latest,
        hasUpdate: latest !== null && current !== 'unknown' && latest !== current,
      }
    } catch (err) {
      return {
        current,
        latest: null,
        hasUpdate: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** 升级宿主应用：先停 → npm install 到 userData/<runtimeDir>/<version> → 写 active → 若原在运行则重启 */
  async upgrade(version: string): Promise<boolean> {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return false
    const wasReady = this._state.status === 'ready'
    await this.stop()

    const targetDir = join(runtimeRoot(this.def), version)
    try {
      mkdirSync(targetDir, { recursive: true })
    } catch (err) {
      this.pushUpgrade({
        phase: 'error',
        version,
        message: `创建运行时目录失败：${err instanceof Error ? err.message : String(err)}`,
      })
      return false
    }

    this.pushUpgrade({ phase: 'installing', version })
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    return new Promise((resolve) => {
      const child = spawn(
        npmCmd,
        ['install', '--prefix', targetDir, `${this.def.packageName}@${version}`],
        {
          env: { ...process.env, npm_config_yes: 'true', npm_config_registry: NPM_REGISTRY },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: process.platform === 'win32',
        },
      )
      child.stderr.on('data', (c: Buffer) => console.error('[agent:upgrade]', c.toString()))
      child.on('exit', (code) => {
        if (code === 0) {
          try {
            writeFileSync(currentFile(this.def), JSON.stringify({ version }, null, 2))
          } catch (err) {
            this.pushUpgrade({
              phase: 'error',
              version,
              message: `写入 active 版本失败：${err instanceof Error ? err.message : String(err)}`,
            })
            return resolve(false)
          }
          this.pushUpgrade({ phase: 'done', version })
          if (wasReady) void this.start()
          resolve(true)
        } else {
          this.pushUpgrade({ phase: 'error', version, message: `npm install 退出 code=${code}` })
          resolve(false)
        }
      })
    })
  }

  /** 卸载：停进程 + 清数据/运行时目录 + 复位状态（数据目录隔离在 userData，删除安全） */
  async uninstall(): Promise<void> {
    this.expectedStop = true
    this.child?.kill()
    this.child = null
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.port = 0
    this.loadedUrl = ''
    this.setVisibleSync(false)
    this.setState({ status: 'idle' })
    await Promise.all([
      rm(dataHome(this.def), { recursive: true, force: true }).catch(() => {}),
      rm(runtimeRoot(this.def), { recursive: true, force: true }).catch(() => {}),
    ])
  }

  // ---- 视图管理（WebContentsView 挂在主窗口 contentView 上）----

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    const win = this.getWindow()
    if (!win || win.isDestroyed()) throw new Error('主窗口不存在，无法挂载 agent 视图')
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    // 导航护栏：钉死本机 loopback，外链交给系统浏览器
    view.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('http://127.0.0.1:')) e.preventDefault()
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https:')) shell.openExternal(url)
      return { action: 'deny' }
    })
    view.setVisible(false)
    win.contentView.addChildView(view)
    this.view = view
    return view
  }

  private async loadIntoView(): Promise<void> {
    if (!this.view || !this._state.url) return
    if (this.loading) return
    if (this.loadedUrl === this._state.url) return
    this.loading = true
    try {
      await this.view.webContents.loadURL(this._state.url)
      this.loadedUrl = this._state.url
      console.log('[agent] view loaded', this._state.url)
    } catch (err) {
      console.error('[agent] 加载 UI 失败：', err instanceof Error ? err.message : String(err))
    } finally {
      this.loading = false
    }
  }

  async setBounds(rect: BoundsRect): Promise<void> {
    this.latestBounds = rect
    if (this.view && this.visible) this.view.setBounds(rect)
  }

  async setVisible(v: boolean): Promise<void> {
    this.visible = v
    if (!v) {
      this.view?.setVisible(false)
      return
    }
    const view = this.ensureView()
    if (this.latestBounds) view.setBounds(this.latestBounds)
    view.setVisible(true)
    if (this._state.status === 'ready') {
      await this.loadIntoView()
    }
  }

  private setVisibleSync(v: boolean): void {
    this.visible = v
    this.view?.setVisible(v)
  }

  // ---- 清理 ----

  destroy(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    this.expectedStop = true
    this.child?.kill()
    if (this.view) {
      const win = this.getWindow()
      if (win && !win.isDestroyed()) {
        win.contentView.removeChildView(this.view)
      }
      this.view.webContents.close()
      this.view = null
    }
  }
}
