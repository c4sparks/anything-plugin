# 插件源码开发目录（独立于壳子代码）

> 约定：**插件源码不放在壳子代码（src/）里，也不直接写 resources/plugins/**。
> `plugins-dev/<id>/` 是每个插件的独立源码工程，构建产物输出到 `resources/plugins/<id>/`（壳子只消费安装目录）。

## 目录结构

```
plugins-dev/<id>/            # 独立 npm 包（自带 package.json + node_modules + 构建配置）
  src/entry.js               # 插件源码（npm 依赖随意用，如 codemirror）
  package.json               # 插件自身依赖与构建脚本
  manifest.json              # 插件 manifest（构建时复制到产物目录）
  → 构建 → resources/plugins/<id>/   # manifest + entry.js（单文件 ESM，≤2MB）
```

## 规则

- 壳子代码 `src/` 与插件源码互不引用：插件源码按独立 npm 包自管理依赖（`plugins-dev/<id>` 内独立 `pnpm install`）。
- 构建脚本（`scripts/build-plugin.mjs`，M2）在插件源码目录内执行，产物为单文件 ESM，写入 `resources/plugins/<id>/entry.js`。
- 打包排除：`plugins-dev/**` 不进安装包/asar（electron-builder files 已排除）。
- 插件源码应纳入版本控制；插件自身 node_modules 由全局 `node_modules` 规则忽略。
- 卸载/升级语义：壳子只认 `resources/plugins/<id>/`（或 prod `userData/plugins/<id>/`），与源码目录无关。

## 依赖与调试

- **运行时**：外部插件走 Blob 加载、单文件 ESM，依赖必须内联进打包产物，**无法也不应使用壳子 node_modules**。
- **构建时依赖**：插件在自身目录独立 `pnpm install`（依赖版本自定义）；esbuild 从插件 node_modules 解析并内联。壳子 node_modules 仅在插件恰好复用壳子已有依赖时可选兜底（会造成版本耦合，不推荐）。
- **调试**：插件运行时用壳子 DevTools 排查；源码级调试用构建脚本 `--debug`（不压缩 + sourcemap），改源码 → debug 构建 → 壳子重扫/重载生效。

## 现状

- 手写单文件外部插件（demo-status）：源码即产物，仍放 `resources/plugins/`。
- 打包型插件（如笔记知识库 notes，设计态）：源码进 `plugins-dev/notes/`，M2 构建脚本落地后可用。
