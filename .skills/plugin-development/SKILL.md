---
name: plugin-development
description: 插件开发规范（webComponent / hostApp）。当需要在本项目中新建、修改、调试或移除插件、处理插件数据存储、遵守 manifest 与主题契约时使用。
---

# 插件开发

本项目插件分两类：**webComponent**（壳内自定义元素）与 **hostApp**（独立 sidecar 进程）。

## 通用约束

- manifest schema、运行时数据形状、校验规则以 `docs/插件契约.md` 为单一事实来源；改契约先改文档并升版本。
- `enabled` 是运行时状态，不得写入 manifest。
- 插件 UI 样式隔离在 shadow DOM，只依赖主题契约 CSS 变量（见 `ui-design` 技能），禁止硬编码颜色。
- 被卸载（视图切换/禁用）时必须在 `disconnectedCallback` 清理定时器/监听器（铁律）。
- 在方法体内读取 `window.api`，不要在模块顶层解构。
- 插件目录：dev `resources/plugins/`，prod `userData/plugins/`；外部插件放目录即被 fs.watch 自动发现。
- 槽位语义：`content` = 单一活动视图（点侧栏进入内容页）；`sidebar`/`statusbar` = 内联小部件；同槽位按 `order` 升序。
- manifest 可选 `icon`（.svg/.png ≤64KB），主进程读取转 data URL。

## webComponent 插件

- 外部插件：无依赖、单文件、纯 ES Module 原生 Web Component（`customElements.define`）；放插件目录即被自动发现。
- 内置插件：编译期注册（`src/renderer/src/plugins/index.ts`）。
- **数据持久化用 `window.api.pluginData.get/set/remove/clear(id, key)`**（存 `userData/plugin-data/<id>/data.json`），**不要用 localStorage**。
  - `key` 白名单：小写 `^[a-z][a-z0-9._-]{0,63}$`（驼峰会被主进程拒绝）；`value` 为字符串。

## hostApp 插件

- 独立进程 + 完全系统权限，只安装可信包。
- 数据/运行时目录经 manifest 的 `dataDir`/`runtimeDir` 隔离到 userData；升级走 npm 版本隔离目录。
- 卸载会停进程并删除其数据/运行时目录。

## 验证

- 新增/修改插件后：`node --check`（外部 entry.js）+ `pnpm typecheck` + `pnpm test:unit` + `pnpm build`。
- UI 验证：临时 Vite 工程 + Playwright 断言；假 `window.api.pluginData` 必须实现真实 key 校验，否则校验类 bug 会漏网。

## 变更对应文档

- 契约（manifest/schema/数据存储）变化 → `docs/插件契约.md`（升版本）。
- 插件功能/交互变化 → `docs/功能设计.md`（对应 demo 插件章节）。
- 插件开发流程/示例变化 → `docs/插件开发速查.md`。
- 新增功能 → `docs/功能清单列表.md` 加条目/更新状态。
