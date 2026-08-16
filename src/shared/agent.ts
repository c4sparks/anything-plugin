/**
 * Agent（DeepSeek Harness 侧车）共享类型。
 * 主进程 AgentManager 维护状态，经 agent:stateChanged 推给渲染层。
 */

export type AgentStatus = 'idle' | 'starting' | 'ready' | 'error' | 'stopped'

export interface AgentState {
  status: AgentStatus
  /** 就绪后的 web UI 地址（http://127.0.0.1:<port>） */
  url?: string
  port?: number
  /** 失败原因 */
  error?: string
}

/** 内容区几何（CSS 像素，renderer .content rect → contentView 坐标） */
export interface BoundsRect {
  x: number
  y: number
  width: number
  height: number
}

/** 版本检查结果 */
export interface UpdateInfo {
  /** 当前生效版本（运行时目录或应用 node_modules） */
  current: string
  /** registry 最新版本；网络失败为 null */
  latest: string | null
  hasUpdate: boolean
  /** 检查失败原因（网络/HTTP） */
  error?: string
}

/** 升级进度（主进程 → 渲染层推送） */
export interface UpgradeState {
  phase: 'checking' | 'installing' | 'done' | 'error'
  /** 目标版本 */
  version?: string
  /** 进度/错误信息 */
  message?: string
}
