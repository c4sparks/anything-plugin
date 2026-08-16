/**
 * 宿主应用（外部 sidecar 程序）定义 —— 可插拔契约。
 * 壳层把「外部宿主应用」当作可配置能力：spawn 命令、就绪解析、数据/运行时目录、
 * 升级（npm 包）、显示名/图标全由一份定义驱动。dsh 是当前唯一实现；
 * 接入其它 sidecar 宿主应用 = 提供一份新的 HostAppDefinition。
 */

/** 壳层可用图标名（与 AppIcon 的 IconName 对齐） */
export type HostAppIcon =
  | 'home'
  | 'plugin'
  | 'gear'
  | 'chevron'
  | 'search'
  | 'box'
  | 'panel'
  | 'spark'
  | 'open'
  | 'play'
  | 'stop'
  | 'refresh'
  | 'upgrade'
  | 'trash'
  | 'power'

export interface HostAppDefinition {
  /** 唯一 id（插件列表/视图路由用） */
  id: string
  /** 显示名（插件列表等完整场景） */
  name: string
  /** 侧栏短名（展开 200px 内放得下） */
  shortName: string
  /** 图标（见 HostAppIcon） */
  icon: HostAppIcon
  /** 描述（插件列表行） */
  description: string
  /** npm 包名（运行时安装 / 版本检查） */
  packageName: string
  /** 包内 host bin 相对路径 */
  hostBin: string
  /** 插件目录内代码根（相对路径；提供后优先本地解析，离线可用，无需 npm 安装/闭包） */
  hostDir?: string
  /** 启动参数（追加到 host bin 之后） */
  cliArgs: string[]
  /** 就绪行正则（从 stdout 提取端口，捕获组 1 = 端口） */
  readyRe: RegExp
  /** 数据目录环境变量名 */
  dataHomeEnv: string
  /** userData 下的数据目录名 */
  dataDir: string
  /** userData 下的运行时安装目录名（版本隔离） */
  runtimeDir: string
  /** 附加环境变量（spawn 时合并） */
  extraEnv: Record<string, string>
}

/** manifest.json 里的宿主应用定义（JSON 形态，readyRe 为 string，主进程校验后编译） */
export interface HostAppManifest {
  /** npm 包名 */
  packageName: string
  /** 包内 host bin 相对路径 */
  hostBin: string
  /** 插件目录内代码根（相对路径，可选；无前导 /、无 ..、无空白，≤256） */
  hostDir?: string
  /** 启动参数 */
  cliArgs: string[]
  /** 就绪行正则字符串（须 ≥1 捕获组 = 端口，非 g 标志） */
  readyRe: string
  /** 数据目录环境变量名 */
  dataHomeEnv: string
  /** userData 下的数据目录名 */
  dataDir: string
  /** userData 下的运行时安装目录名 */
  runtimeDir: string
  /** 附加环境变量 */
  extraEnv: Record<string, string>
}

/** 把校验过的 manifest hostApp 定义编译为运行时 HostAppDefinition */
export function compileHostAppDef(
  json: HostAppManifest,
  meta: { id: string; name: string; shortName?: string; icon?: HostAppIcon; description?: string },
): HostAppDefinition {
  return {
    id: meta.id,
    name: meta.name,
    shortName: meta.shortName ?? meta.name,
    icon: meta.icon ?? 'plugin',
    description: meta.description ?? '',
    packageName: json.packageName,
    hostBin: json.hostBin,
    ...(json.hostDir != null ? { hostDir: json.hostDir } : {}),
    cliArgs: json.cliArgs,
    readyRe: new RegExp(json.readyRe),
    dataHomeEnv: json.dataHomeEnv,
    dataDir: json.dataDir,
    runtimeDir: json.runtimeDir,
    extraEnv: json.extraEnv,
  }
}

/** DeepSeek Harness（dsh）宿主应用定义 */
export const DSH_HOST_APP: HostAppDefinition = {
  id: 'dsh-agent',
  name: 'DeepSeek Harness',
  shortName: 'AI 助手',
  icon: 'spark',
  description: 'LLM / 工具 / 会话 / 子进程沙箱。点侧栏使用。',
  packageName: '@deepseek-ai/dsh',
  hostBin: 'lib/bin.js',
  cliArgs: ['web', '--port', '0'],
  readyRe: /dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)/i,
  dataHomeEnv: 'DSH_HOME',
  dataDir: 'dsh',
  runtimeDir: 'dsh-runtime',
  extraEnv: { DSH_TELEMETRY_DISABLED: '1' },
}
