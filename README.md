# AnythingPlugin

基于 **Electron + Vue 3 + electron-vite + pnpm** 的**万物皆插件**桌面应用壳。

核心定位：**应用壳本身不内置功能，一切靠插件**——扩展功能的 UI 以 Web Component 挂载到壳层槽位，
外部宿主应用（如 agent）以独立进程嵌入。

## 核心特性

- **壳层 UI**：Element Plus 按需接入，主题变量与设计令牌对齐，深浅色一键切换并持久化。
- **插件管理**：统一列表 + 搜索（多关键词空格分词 / 拼音全拼·首字母 / 子串）、三行信息布局、图标操作按钮（title 悬停）、安全模式门控、**双击进详情页**（README Markdown 渲染 + 元信息面板）。
- **hostApp 多宿主**：manifest `kind: hostApp` 声明外部宿主应用（npm 包 + 启动参数 + 就绪行），壳层 spawn 独立进程并嵌入其 Web UI；第三方 hostApp 归 thirdParty + 安全模式门控 + 「独立程序」警示。
- **DeepSeek Harness（内置 hostApp）**：sidecar 子进程运行 dsh web，WebContentsView 嵌入；可启停 / 升级 / 卸载重装。
- **外部插件动态加载**：`manifest.json + entry.js` 放入插件目录自动发现，重新扫描 / 目录监听即时刷新；支持本地 zip 导入与市场安装（注册表地址可配置）。
- **打包分发**：electron-builder 把侧车运行时（重命名 Node + 自包含闭包）打进安装包，装完即用。

## 技术栈

| 领域   | 选型                                                                                    |
| ------ | --------------------------------------------------------------------------------------- |
| 构建   | [electron-vite](https://electron-vite.org) v5（main/preload/renderer 三段式）           |
| 框架   | Vue 3（`<script setup>`）+ Vite 7 + Element Plus（按需）                                |
| 语言   | TypeScript 6（strict）                                                                  |
| 包管理 | pnpm 11（`packageManager` 声明，`pnpm-workspace.yaml` 放行构建脚本）                    |
| 打包   | electron-builder 26（win-nsis / mac-dmg / linux-AppImage）+ 侧车 sidecar               |
| 测试   | Vitest 4（单测）+ Playwright 1.62（Electron e2e）                                       |
| 质量   | ESLint 10（vue + ts）+ Prettier 3                                                       |

## 快速开始

```sh
pnpm install          # 安装依赖（electron 二进制已配 npmmirror 镜像）
pnpm dev              # 开发（HMR + 自动启动 Electron）
pnpm build            # 类型检查 + 构建到 out/
```

全部常用命令：

| 命令 | 说明 |
| ---- | ---- |
| `pnpm dev` | 开发模式（HMR + 自动启动 Electron） |
| `pnpm start` | 预览构建产物 |
| `pnpm typecheck` | node + web 双项目类型检查 |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm test:unit` | Vitest 单测（manifest 校验/搜索/编译） |
| `pnpm test:e2e` | Playwright Electron e2e（需先 build） |
| `pnpm build` | 类型检查 + 构建到 `out/` |
| `pnpm package:sidecar` | 生成打包sidecar运行时 `resources/dsh-host`（幂等：缺失或 dsh 版本变化才生成） |
| `pnpm build:win` | 构建 + 自动准备 sidecar + electron-builder 打包（win-nsis） |
| `pnpm build:mac` | 构建 + electron-builder 打包（mac-dmg，需 macOS 环境） |
| `pnpm build:linux` | 构建 + electron-builder 打包（linux-AppImage） |

> 打包sidecar：`build:win` 会自动调用 `package:sidecar`（幂等——`resources/dsh-host` 已存在且 dsh
> 版本未变则跳过），生成重命名 Node + dsh 闭包后经 `extraResources` 部署进安装包
> （sidecar 只进安装包，不进 asar）。

## 插件体系

### 插件种类

| 种类 | 含义 | 承载 | 信任 |
| ---- | ---- | ---- | ---- |
| `webComponent` | 壳层 Web Component（Vue/WC 组件挂槽位） | 自定义元素 `app-plugin-*`，槽位 sidebar/content/statusbar | 内置 trusted / 外部 thirdParty（沙箱 + 安全模式门控） |
| `hostApp` | 外部宿主应用（独立 sidecar 进程，嵌入其 Web UI） | manifest `kind: hostApp` + `HostAppDefinition` | 内置 trusted / 外部 thirdParty（**独立进程 + 完全系统权限**，红色警示） |

### DeepSeek Harness（内置 hostApp）

`DeepSeek Harness` 是内置 hostApp 插件：壳层以 sidecar 子进程（系统 node v22.20）运行 dsh web，
WebContentsView 嵌入其 UI。支持启动/停止、版本检查/升级（npm 运行时安装，版本隔离）、卸载/重装。
外部 hostApp 可从插件目录安装（多宿主），如 `resources/plugins/demo-host` 示例。

### 插件管理

统一列表（无分类 Tab），内置/外部以徽标区分；搜索增强；行操作 = 图标按钮（打开/启停/升级/检查更新/卸载/启禁用，
title 悬停）；安全模式开关在搜索栏右侧；**双击行进详情页**（左 README 正文 + 右元信息面板）。

## 插件开发指南

### 1. Vue SFC 插件（内置，推荐）

`src/renderer/src/plugins/widgets/` 建组件，`src/renderer/src/plugins/index.ts` 注册：

```ts
import { registerVuePlugin } from './registry'
import MyWidget from './widgets/MyWidget.vue'

registerVuePlugin(
  { id: 'my-widget', name: '我的插件', kind: 'webComponent', tag: 'app-plugin-my-widget',
    slot: 'content', order: 20 },
  MyWidget,
)
```

### 2. 原生 Web Component（内置）

`customElements.define(tag, class extends HTMLElement {...})` 后 `registerPlugin({ id, name, kind: 'webComponent', tag, slot })` 注册。

### 3. 外部 webComponent 插件（本地动态加载）

插件包 = `manifest.json + entry.js`，放入插件目录（dev `resources/plugins/`，prod `userData/plugins/`）→「重新扫描」加载。
约束：entry.js 无依赖、单文件、纯 ESM 原生 WC；manifest 必填 `id/name/tag/slot/entry`，`enabled` 不写 manifest。

### 4. hostApp 插件（外部宿主应用）

`manifest.json` 声明 `kind: "hostApp"` + `hostApp` 定义（packageName / hostBin / cliArgs / readyRe / dataDir 等，主进程强校验防注入）。
宿主程序须 stdout 打印匹配 `readyRe` 的就绪行（捕获组 1 = 端口）并在 `127.0.0.1:<port>` 提供 Web UI。
示例见 `resources/plugins/demo-host/manifest.json`。

### 插件调用主进程 / 样式

- 经 preload 白名单 `window.api.*`，禁止直接 Node/Electron 能力。
- UI 样式隔离在 shadow DOM，只依赖主题契约 CSS 变量（禁止硬编码颜色）。

## 安全

- `contextIsolation: true`，渲染层无 `nodeIntegration`；preload 只暴露白名单 API。
- 外链经 `setWindowOpenHandler` 拦截；单实例锁防多开。
- CSP `script-src 'self' blob:`（为外部插件模块刻意放宽；IPC 全量校验来源，`plugins:load` 只认插件 id）。
- **hostApp 安全**：manifest 字段（packageName/readyRe/env/URL）主进程强校验防注入；外部 hostApp = thirdParty + 安全模式门控 + 「独立程序」警示（真实子进程 + 完全系统权限，只安装信任的包）。
- README/CHANGELOG 等详情文档 ≤64KB 读取；详情 README Markdown 渲染前 **DOMPurify sanitize** 防 XSS。
