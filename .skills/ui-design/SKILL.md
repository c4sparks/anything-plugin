---
name: ui-design
description: UI 设计契约（仪器面板气质、设计令牌、Element Plus、插件主题契约）。当需要在本项目中新建或修改壳层页面、插件界面、深浅色主题相关 UI 时使用。
---

# UI 设计

本项目 UI 契约：**仪器面板**气质（冷机器灰 + 铜绿青强调色）。设计令牌唯一实现在 `src/renderer/src/assets/main.css`。

## 设计令牌

- 颜色、间距、圆角、阴影、字号、动效一律用 CSS 变量（`--surface`、`--space-*`、`--radius-*`、`--accent` 等），深浅色随 `[data-theme='dark']` 自动切换。
- 禁止硬编码颜色；插件 shadow DOM 只能依赖变量（可带 fallback 值）。
- 数据/状态用等宽字体变量（`--font-mono`）；眉标用 xs 字号 + 大写 + 0.08em 字距。

## 插件 UI（shadow DOM）

- 样式隔离，不依赖壳层全局 class/元素选择器。
- 遵守 `prefers-reduced-motion`（禁用装饰动画）。
- 交互控件需 `:focus-visible` 焦点环；只读信息控件可按需去掉聚焦变色。

## 壳层 UI

- 使用 Element Plus（`el-*` 组件），`--el-*` 变量已映射到设计令牌，主题自动联动。
- 布局遵循 4px 栅格；面板 = `--surface` + `--border` + `--radius-lg`（可加 `--shadow-1`）。
- 深色模式：`html.dark` 与 `[data-theme='dark']` 同步。
- 布局关键尺寸（标题栏/侧栏/状态栏）与侧栏三段菜单契约见 `docs/设计规范.md` §3/§9。

## 验证

- 深浅两套主题都要验证（Playwright 断言实际色值）。
- 完整设计规范见 `docs/设计规范.md`，本技能不重复细节。

## 变更对应文档

- UI 契约 / 布局 / 组件规范变化 → `docs/设计规范.md`（设计令牌唯一实现在 `main.css`，同步修改）。
