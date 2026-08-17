# notes 笔记插件（TypeScript 多文件版）

个人知识库插件（左右布局 + 文件夹/文件树 + 排序 + 展开收起 + 右键菜单 + 分屏多开）的 **TypeScript 移植**：源码从单文件 `entry.js`（2204 行）重构为多文件 TS，产物仍是单文件 ESM，通过自定义元素 `<app-plugin-notes>` 嵌入宿主 Web Component 槽位。

## 为什么多文件

- 产物约束（单文件 ESM、≤2MB、无裸导入）由 esbuild 打包保证，与源码文件数无关；
- 拆分后各模块职责单一、可独立类型检查，详见各文件头注释。

## 目录结构

```
notes/
├── src/                 # TS 源码
│   ├── entry.ts         # 入口：customElements.define('app-plugin-notes', NotesApp)
│   ├── notes-app.ts     # NotesApp 主类：渲染/事件绑定/树/面板/编辑器/右键/弹层（全部业务逻辑）
│   ├── types.ts         # 数据模型：PaneRecord / CardRecord / SplitTree / DialogState / SortOption …
│   ├── api.ts           # window.api 宿主契约声明（docs/插件契约.md §5 plugin-data / §6 plugin-files）
│   ├── editor.ts        # CodeMirror 主题 + 跨面板同步 annotation（Sync）
│   ├── live-preview.ts  # 普通模式所见即所得：decoration 插件 + 表格/任务复选框 widget
│   ├── icons.ts         # SVG 图标常量
│   ├── util.ts          # 纯函数：转义 / 高亮 / removeLeaf / DOM 查询辅助
│   └── styles.ts        # 壳层 CSS 模板（原 renderShell 内嵌 <style> 原样提取）
├── scripts/
│   └── build.mjs        # 构建脚本：src/entry.ts → dist/ 单文件 ESM + 后处理校验
├── manifest.json        # 插件清单（kind=webComponent, tag=app-plugin-notes）
├── package.json         # 依赖（codemirror / marked / dompurify）+ 命令
├── pnpm-lock.yaml       # pnpm 锁文件（自动生成）
├── pnpm-workspace.yaml  # pnpm 11 构建白名单（allowBuilds: esbuild）
├── tsconfig.json        # 类型检查配置（include: ["src"]）
├── README.md            # 本文件
└── dist/                # 构建产物（entry.js + manifest.json，pnpm build 生成）
```

> 注：`node_modules/`、`.pnpm-store/`、`.npm-cache/`、`dist/` 均被仓库 `.gitignore` 忽略（不入库）。

## 命令

```bash
pnpm install          # 首次安装依赖（pnpm 11 默认不跑构建脚本，esbuild 由 pnpm-workspace.yaml 的 allowBuilds 放行）
pnpm typecheck        # tsc --noEmit 类型检查（esbuild 只转译不查类型，必须单独跑）
pnpm build            # esbuild 打包 → dist/entry.js（单文件 ESM，minify）
pnpm build:debug      # 打包不压缩 + sourcemap
pnpm watch            # 监听 src/ 与 manifest.json 改动自动重建（Ctrl+C 退出）
```

> 独立插件包构建不依赖框架。框架侧若想把它构建进 app 资源试玩，可在仓库根跑 `pnpm build:plugin notes` → `resources/plugins/notes/`（入口同样支持 TS）。
>
> 注意：`pnpm typecheck` / `pnpm build` 前若 pnpm 检测到有依赖构建脚本被忽略（`ERR_PNPM_IGNORED_BUILDS`），会先自动跑一次 `install` 并报错退出——把 `pnpm-workspace.yaml` 里的 `esbuild: true` 配好即可避免。


## 常见问题

- **产物校验**：≤2MB、无裸导入由 `scripts/build.mjs` 后处理自动检查，不通过会报错退出；
- **沙箱/权限**：本目录曾在受限环境安装，`node_modules` 与 `.pnpm-store` 若异常可删除后重跑 `pnpm install`（store 缓存可复用，重装很快）。
