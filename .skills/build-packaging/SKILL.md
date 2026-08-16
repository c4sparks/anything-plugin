---
name: build-packaging
description: 构建与打包流程（build:win/mac/linux、sidecar、NSIS 安装包）。当需要打包本项目、修复构建/下载/安装包问题、准备 dsh 侧车、或排查 electron-builder 与 Electron 二进制故障时使用。
---

# 构建与打包

## 命令

- `pnpm build`：typecheck + electron-vite build（产物 `out/`）。
- `pnpm build:win`：typecheck → build → **自动幂等准备 sidecar** → electron-builder --win（NSIS）。
- `pnpm package:sidecar`：单独生成打包侧车（`resources/dsh-host`，构建产物，已 gitignore）。

前置：先 `pnpm install` 保证依赖完整（`package:sidecar` 依赖 `node_modules/@deepseek-ai/dsh`）；mac/linux 打包配置就绪但需对应环境验证（未在本机验证）。

## 关键事实

- Electron 二进制与构建工具下载走 npmmirror 镜像（`.npmrc` 的 `electron_mirror` / `electron_builder_binaries_mirror`）。
- `@electron/get` 命中本地 zip 缓存后仍会联网拉 SHASUMS256.txt 校验；已配置 `electronDownload.isVerifyChecksum: false`，命中缓存可离线打包。
- 打包版 dsh 侧车依赖 `resources/dsh-host`；缺失时打出的安装包没有侧车（DeepSeek Harness 无法启动）。
- NSIS 卸载器带自定义询问页（`build/nsis/uninstall-app-data.nsh`）：默认保留用户数据，勾选才清除。
- 升级/检查更新走 npm registry：优先 `npm_config_registry` 环境变量，代码兜底为国内镜像。

## 常见故障

- `fetch failed` / 二进制下载失败：网络或镜像问题，检查缓存与镜像配置。
- dev 报 `Error: Electron uninstall`：`node_modules/electron` 的 `path.txt`/`dist` 缺失——先确保无 electron 进程占锁，再 `pnpm install --force`。
- NSIS 自定义脚本编译报 MUI 宏未定义或变量未引用：引用 MUI 宏的代码必须放进 `customUnWelcomePage` 宏内延迟展开（include 在 MUI2 之前解析）；变量声明也须在宏内（makensis `-WX` 把 warning 当错误）。

## 验证

- 打包后检查 `dist/win-unpacked/resources/dsh-host/dsh-host.exe` 存在且 `--version` 正常。
- `electron-builder --win` 需编译通过（含卸载器签名）。

## 变更对应文档

- 打包配置（electron-builder.yml / NSIS / sidecar）变化 → `docs/详细设计.md` 打包章节。
- 命令 / 使用说明变化 → `README.md` 命令表与说明。
- 打包能力 / 状态变化 → `docs/功能清单列表.md` G 节。
