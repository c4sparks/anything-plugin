// 壳层样式（原 entry.js renderShell 内嵌 <style>，原样提取；变量走宿主 CSS 变量并带兜底值）
// P2：内联 highlight.js 主题与 KaTeX 布局 CSS（构建脚本以 text loader 注入；字体 404 时回退系统字体）
import hljsTheme from 'highlight.js/styles/github.css'
import katexCss from 'katex/dist/katex.min.css'

export const SHELL_CSS = `
        :host { display: block; width: 100%; height: 100%; min-height: 480px; }
        * { box-sizing: border-box; }
        .app {
          width: 100%; height: 100%; min-height: inherit;
          display: flex;
          position: relative;
          background: var(--surface, #fff);
          border: 1px solid var(--border, #d9dce2);
          border-radius: 0;
          box-shadow: none;
          font-family: var(--font-ui, system-ui, sans-serif);
          overflow: hidden;
        }
        .side { width: 260px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--border, #d9dce2); background: var(--surface-2, #eceef1); }
        /* 折叠为窄条：只留折叠/展开按钮（宽度 = SIDE_COLLAPSED 36px，容纳 30px 按钮 + 4px 工具栏内边距） */
        .side.collapsed { width: 36px !important; }
        /* 书本图标整体隐藏/显示侧边栏 */
        .side.hidden { display: none; }
        .side.collapsed .toolbar { flex-direction: column; gap: 2px; justify-content: flex-start; }
        .side.collapsed .toolbar .icon-btn:not([data-act="toggle-side"]) { display: none; }
        .side.collapsed .tree { display: none; }
        .splitter { flex: none; width: 5px; cursor: col-resize; background: transparent; transition: background var(--duration-fast, 120ms) ease; }
        .splitter:hover, .splitter.dragging { background: var(--accent, #0e7c6b); opacity: .55; }
        .toolbar { display: flex; align-items: center; gap: var(--space-1, 4px); padding: 4px; border-bottom: 1px solid var(--border, #d9dce2); flex-wrap: wrap; }
        .icon-btn {
          width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center;
          border: 1px solid transparent; border-radius: var(--radius-base, 6px);
          background: transparent; color: var(--text, #1a1d23); cursor: pointer;
          transition: background var(--duration-fast, 120ms) ease, color var(--duration-fast, 120ms) ease;
        }
        .icon-btn:hover { background: var(--surface, #fff); color: var(--accent, #0e7c6b); }
        .icon-btn:focus-visible { outline: 2px solid var(--focus-ring, rgba(14,124,107,.35)); outline-offset: 1px; }
        .icon-btn svg { width: 16px; height: 16px; }
        .search-wrap { position: relative; flex: 1; min-width: 56px; }
        .search-wrap .side-search { width: 100%; }
        .side-search {
          width: 100%; height: 26px; padding: 0 var(--space-2, 8px);
          border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-pill, 999px);
          background: var(--surface, #fff); color: var(--text, #1a1d23); font-size: var(--font-size-xs, 12px); outline: none;
        }
        .side-search:focus { border-color: var(--accent, #0e7c6b); box-shadow: 0 0 0 3px var(--focus-ring, rgba(14,124,107,.35)); }
        /* 侧栏搜索框（文件树与工具栏之间）：wrap 用 margin 不占内边距，× 清除按钮（absolute right:3px）才能落在输入框内 */
        .side .search-wrap { flex: none; margin: 4px 6px; padding: 0; }
        .side .side-search { padding-right: 26px; } /* 给 × 按钮留位，输入文字不压按钮 */
        /* 全文搜索结果列表（搜索时替换文件树） */
        .search-results { flex: 1; min-height: 0; overflow-y: auto; padding: 4px; }
        .search-results[hidden] { display: none; }
        .sr-item { display: block; padding: 5px var(--space-2, 8px); border-radius: var(--radius-base, 6px); cursor: pointer; font-size: var(--font-size-sm, 13px); color: var(--text, #1a1d23); white-space: nowrap; overflow: hidden; }
        .sr-item:hover { background: var(--surface, #fff); }
        .sr-item .sr-title { display: block; overflow: hidden; text-overflow: ellipsis; }
        .sr-item .sr-title mark { background: var(--accent, #0e7c6b); color: var(--accent-text, #fff); border-radius: 2px; padding: 0 1px; }
        .sr-item .sr-crumb { display: block; font-size: 11px; color: var(--text-muted, #5b6370); overflow: hidden; text-overflow: ellipsis; }
        .sr-empty { padding: var(--space-3, 12px); font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); }
        .search-status { flex: none; padding: 3px 8px; font-size: 11px; color: var(--text-muted, #5b6370); }
        .side.collapsed .search-wrap, .side.collapsed .search-results, .side.collapsed .search-status { display: none; }
        .search-clear {
          position: absolute; top: 50%; right: 3px; transform: translateY(-50%);
          width: 18px; height: 18px; display: none; align-items: center; justify-content: center;
          border: none; border-radius: 50%; background: var(--border-strong, #b6bcc7); color: var(--surface, #fff);
          cursor: pointer; padding: 0;
        }
        .search-clear:hover { background: var(--text-muted, #5b6370); }
        .search-clear svg { width: 10px; height: 10px; }
        /* 有输入数据(.show)且鼠标悬停/聚焦输入框时才显示 */
        .search-wrap:hover .search-clear.show, .search-wrap:focus-within .search-clear.show { display: inline-flex; }
        .tree { flex: 1; overflow-y: auto; padding: 0; }
        .t-row {
          display: flex; align-items: center; gap: var(--space-1, 4px);
          height: 26px; padding: 0 var(--space-1, 4px); border-radius: var(--radius-base, 6px);
          cursor: pointer; font-size: var(--font-size-sm, 13px); color: var(--text, #1a1d23);
          white-space: nowrap; user-select: none; flex: none; overflow: hidden;
        }
        /* 虚拟化占位块（撑起未渲染区高度，与 ROW_H=26 对齐） */
        .tree-spacer { flex: none; }
        .t-row:hover { background: var(--surface, #fff); }
        .t-row.sel { background: var(--surface, #fff); box-shadow: inset 2px 0 0 var(--accent, #0e7c6b); }
        .t-row .caret { flex: none; width: 14px; text-align: center; color: var(--text-muted, #5b6370); font-size: 10px; }
        .t-row .ic { flex: none; width: 16px; text-align: center; color: var(--text-muted, #5b6370); }
        .t-row.folder .ic { color: var(--accent, #0e7c6b); }
        .t-row .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .t-row .nm mark { background: var(--accent, #0e7c6b); color: var(--accent-text, #fff); border-radius: 2px; padding: 0 1px; }
        .t-row.cur { color: var(--accent, #0e7c6b); font-weight: var(--font-weight-medium, 500); }
        .t-empty { padding: var(--space-3, 12px); font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); }
        .editor { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        /* 顶部标签栏：多标签（每个打开的笔记一个标签），激活标签白底与下方内容连通 */
        .tabs-bar {
          display: flex; align-items: stretch; flex: none;
          /* 白底：消除标签与 + 之间露出的灰色空隙（tabs-bar 底色） */
          background: var(--surface, #fff);
          border-bottom: 1px solid var(--border, #d9dce2);
          min-height: 36px;
        }
        .tabs { display: flex; align-items: flex-end; flex: 1; min-width: 0; gap: 2px; padding: 4px 4px 0; overflow-x: auto; }
        .tabs::-webkit-scrollbar { height: 4px; }
        .tab {
          flex: none; min-width: 72px; max-width: 200px; height: 30px;
          display: inline-flex; align-items: center; gap: 4px;
          padding: 0 12px;
          border: 1px solid var(--border, #d9dce2); border-bottom: none;
          border-radius: var(--radius-base, 6px) var(--radius-base, 6px) 0 0;
          background: var(--surface-2, #eceef1);
          color: var(--text-muted, #5b6370);
          font-size: var(--font-size-sm, 13px);
          cursor: pointer; user-select: none;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .tab:hover { color: var(--text, #1a1d23); }
        .tab.active { background: var(--surface, #fff); color: var(--text, #1a1d23); font-weight: var(--font-weight-medium, 500); margin-bottom: -1px; }
        .tab-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tab-close {
          flex: none; width: 16px; height: 16px; margin-left: 2px;
          display: inline-flex; align-items: center; justify-content: center;
          border: none; border-radius: 3px; background: transparent;
          color: var(--text-muted, #5b6370); font-size: 13px; line-height: 1; cursor: pointer; padding: 0;
        }
        .tab-close:hover { background: var(--surface-2, #eceef1); color: var(--text, #1a1d23); }
        /* 分屏中的标签：小图标标示其正在分屏（方向跟随分屏菜单） */
        .tab-split-glyph { flex: none; display: inline-flex; width: 12px; height: 12px; color: var(--accent, #0e7c6b); }
        .tab-split-glyph svg { width: 12px; height: 12px; }
        .tabs-empty { align-self: center; padding: 0 12px; font-size: var(--font-size-xs, 12px); color: var(--text-muted, #5b6370); }
        .tabs-actions { display: flex; align-items: center; gap: 2px; padding: 3px 6px; flex: none; }
        .tabs-actions .icon-btn { width: 28px; height: 28px; }
        /* 页面级控制栏：左=面包屑路径（我在哪），右=工具图标（我能做什么） */
        .page-bar {
          display: flex; align-items: center; gap: var(--space-2, 8px);
          flex: none; min-height: 40px;
          padding: 0 var(--space-4, 16px);
          background: var(--surface, #fff);
          border-bottom: 1px solid var(--border, #d9dce2);
        }
        .crumb { flex: 1; min-width: 0; display: flex; align-items: center; gap: 2px; font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); overflow: hidden; white-space: nowrap; }
        .crumb-item { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .crumb-item.folder { cursor: pointer; }
        .crumb-item.folder:hover { color: var(--accent, #0e7c6b); }
        .crumb-item.cur { color: var(--text, #1a1d23); font-weight: var(--font-weight-medium, 500); }
        .crumb-sep { flex: none; margin: 0 2px; color: var(--border-strong, #b6bcc7); }
        .page-actions { display: flex; align-items: center; gap: 2px; flex: none; }
        .page-actions .icon-btn { width: 30px; height: 30px; }
        .editor-body { flex: 1; min-height: 0; display: flex; }
        .main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
        .main > * { min-width: 0; min-height: 0; }
        .card { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
        /* 卡片：自带标签栏 + 路径栏 + 编辑器，每个分屏面板是完整的一份 */
        .card-tabs { display: flex; align-items: stretch; gap: 2px; padding: 4px 4px 0; background: var(--surface, #fff); border-bottom: 1px solid var(--border, #d9dce2); min-height: 34px; overflow-x: auto; }
        .card-tabs::-webkit-scrollbar { height: 4px; }
        .ctab {
          flex: none; min-width: 72px; max-width: 180px; height: 28px;
          display: inline-flex; align-items: center; gap: 4px;
          padding: 0 10px;
          border: 1px solid var(--border, #d9dce2); border-bottom: none;
          border-radius: var(--radius-base, 6px) var(--radius-base, 6px) 0 0;
          background: var(--surface-2, #eceef1);
          color: var(--text-muted, #5b6370);
          font-size: var(--font-size-sm, 13px);
          cursor: pointer; user-select: none;
        }
        .ctab.active { background: var(--surface, #fff); color: var(--text, #1a1d23); font-weight: var(--font-weight-medium, 500); margin-bottom: -1px; }
        .ctab-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ctab-close { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 3px; background: transparent; color: var(--text-muted, #5b6370); font-size: 12px; line-height: 1; cursor: pointer; padding: 0; }
        .ctab-close:hover { background: var(--surface-2, #eceef1); color: var(--danger, #b3372e); }
        .ctab-new { flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: var(--radius-sm, 4px); background: transparent; color: var(--text-muted, #5b6370); cursor: pointer; padding: 0; }
        .ctab-new:hover { color: var(--accent, #0e7c6b); background: var(--surface-2, #eceef1); }
        .ctab-new svg { width: 14px; height: 14px; }
        .card-page { display: flex; align-items: center; gap: var(--space-1, 4px); padding: 2px 8px; min-height: 26px; border-bottom: 1px solid var(--border, #d9dce2); background: var(--surface, #fff); }
        .card-crumb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-muted, #5b6370); }
        .card-more { width: 22px; height: 22px; flex: none; border: none; border-radius: var(--radius-sm, 4px); background: transparent; color: var(--text-muted, #5b6370); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; }
        .card-more svg { width: 14px; height: 14px; }
        .card-more:hover { background: var(--surface-2, #eceef1); color: var(--text, #1a1d23); }
        .card.active { box-shadow: inset 0 2px 0 var(--accent, #0e7c6b); } /* 聚焦卡片顶边高亮 */
        /* 卡片主体：左=编辑器，右=卡片导航（搜索+大纲） */
        .card-body { flex: 1; min-height: 0; display: flex; }
        .card-editor { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
        .card-nav { flex: none; width: 220px; min-width: 0; border-left: 1px solid var(--border, #d9dce2); background: var(--surface-2, #eceef1); display: flex; flex-direction: column; min-height: 0; }
        .card-nav-toolbar { position: relative; display: flex; align-items: center; gap: var(--space-1, 4px); padding: var(--space-2, 8px); border-bottom: 1px solid var(--border, #d9dce2); }
        .card-nav-search { flex: 1; width: 100%; height: 24px; padding: 0 var(--space-2, 8px); padding-right: 26px; border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-pill, 999px); background: var(--surface, #fff); color: var(--text, #1a1d23); font-size: var(--font-size-xs, 12px); outline: none; }
        .card-nav-search:focus { border-color: var(--accent, #0e7c6b); box-shadow: 0 0 0 2px var(--focus-ring, rgba(14,124,107,.35)); }
        /* 清除按钮：叠于输入框内部右缘；有输入数据(.show)且鼠标悬停/聚焦输入框时才显示 */
        .card-nav-clear { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; display: none; align-items: center; justify-content: center; border: none; border-radius: 50%; background: var(--border-strong, #b6bcc7); color: var(--surface, #fff); cursor: pointer; padding: 0; font-size: 11px; line-height: 1; }
        .card-nav-toolbar:hover .card-nav-clear.show, .card-nav-toolbar:focus-within .card-nav-clear.show { display: inline-flex; }
        .card-nav-clear:hover { background: var(--text-muted, #5b6370); }
        .card-nav-outline { flex: 1; overflow-y: auto; padding: var(--space-2, 8px); }
        .card-nav-outline mark { background: #ffd54d; color: #3a2d00; border-radius: 2px; padding: 0 1px; font-weight: 600; }
        .nav-item { padding: 3px var(--space-2, 8px); border-radius: var(--radius-sm, 4px); cursor: pointer; font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .nav-item:hover { background: var(--surface, #fff); color: var(--text, #1a1d23); }
        .nav-empty { padding: var(--space-2, 8px); font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); }
        /* 多开拆分：递归 .split 容器 + .pane；布局由拆分树驱动，viewMode 不决定布局 */
        .split { flex: 1; min-width: 0; min-height: 0; display: flex; }
        .split[data-dir="row"] { flex-direction: row; }
        .split[data-dir="column"] { flex-direction: column; }
        .split > .split, .split > .card { flex: 1; min-width: 0; min-height: 0; }
        /* 可拖拽分割线：浅紫虚线，两端各留 3px 命中区，hover 加深；顶层左右分屏的竖线贯穿标签栏/路径栏 */
        .split-divider { flex: none; position: relative; }
        .split[data-dir="row"] > .split-divider { width: 7px; cursor: col-resize; }
        .split[data-dir="row"] > .split-divider::before { content: ''; position: absolute; top: 0; bottom: 0; left: 2px; width: 3px; border-left: 2px dashed #b7a3f0; }
        .split[data-dir="column"] > .split-divider { height: 7px; cursor: row-resize; }
        .split[data-dir="column"] > .split-divider::before { content: ''; position: absolute; left: 0; right: 0; top: 2px; height: 3px; border-top: 2px dashed #b7a3f0; }
        .split-divider:hover::before, .split-divider.dragging::before { border-color: #8b5cf6; }
        /* 拖拽落点提示：鼠标下方小标签（内容→插入链接），不覆盖/置灰面板 */
        .drag-hint {
          position: fixed; z-index: 60; display: none;
          padding: 3px 8px; border-radius: var(--radius-sm, 4px);
          background: var(--surface, #fff); border: 1px solid var(--border-strong, #b6bcc7);
          box-shadow: var(--shadow-1, 0 1px 3px rgba(0,0,0,.12));
          color: var(--accent, #0e7c6b); font-size: 12px; font-weight: var(--font-weight-semibold, 600);
          pointer-events: none; white-space: nowrap;
        }
        .drag-hint.show { display: block; }
        /* 每卡片独立显示模式：preview 时隐藏编辑器、显示渲染预览 */
        .card .preview { display: none; }
        .card[data-mode="preview"] .cm-wrap { display: none; }
        .card[data-mode="preview"] .preview { display: block; }
        /* 干净模式：普通/预览隐藏行号；源码模式保留行号并回退等宽字体 */
        .card[data-mode="normal"] .cm-gutters, .card[data-mode="preview"] .cm-gutters { display: none; }
        .card[data-mode="source"] .cm-content { font-family: var(--font-mono, monospace); font-size: 13px; }
        .cm-wrap { flex: 1; min-height: 0; overflow: hidden; }
        .main > .placeholder, .card > .placeholder, .cm-wrap .placeholder { padding: var(--space-5, 24px); font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); }
        /* 普通模式（所见即所得实时预览）样式 */
        .cm-line.cm-live-h1 { font-size: 28px; font-weight: 700; border-bottom: 1px solid var(--border, #d9dce2); line-height: 1.35; padding: .4em 0 .25em; }
        .cm-line.cm-live-h2 { font-size: 21px; font-weight: 700; line-height: 1.35; padding: .7em 0 .3em; }
        .cm-line.cm-live-h3 { font-size: 17px; font-weight: 600; line-height: 1.4; padding: .5em 0 .2em; }
        .cm-line.cm-live-h4, .cm-line.cm-live-h5, .cm-line.cm-live-h6 { font-size: 15px; font-weight: 600; padding: .3em 0 .1em; }
        .cm-line.cm-live-quote { color: var(--text-muted, #5b6370); border-left: 3px solid var(--accent, #0e7c6b); padding: .15em 0 .15em var(--space-3, 12px); background: var(--surface-2, #eceef1); border-radius: 0 var(--radius-sm, 4px) var(--radius-sm, 4px) 0; }
        .cm-line.cm-live-codeblock { background: var(--surface-2, #eceef1); font-family: var(--font-mono, monospace); font-size: 13px; }
        .cm-line span.cm-live-strong { font-weight: 700; }
        .cm-line span.cm-live-em { font-style: italic; }
        .cm-line span.cm-live-code { font-family: var(--font-mono, monospace); font-size: 12px; background: var(--surface-2, #eceef1); border-radius: var(--radius-sm, 4px); padding: 0 2px; }
        .cm-line span.cm-live-link { color: var(--accent, #0e7c6b); text-decoration: underline; cursor: pointer; }
        .cm-line span.cm-live-del { text-decoration: line-through; }
        .cm-line span.cm-live-img { color: var(--accent, #0e7c6b); font-style: italic; }
        .cm-line.cm-live-hr { border-top: 1px solid var(--border-strong, #b6bcc7); }
        .cm-line.cm-live-table { background: var(--surface-2, #eceef1); }
        .cm-line.cm-live-table-head { font-weight: 600; }
        .cm-live-tbl-sep { display: inline-block; width: 8px; margin: 0 3px; border-left: 1px solid var(--border-strong, #b6bcc7); height: 1em; vertical-align: middle; }
        .cm-line.cm-live-task-done { color: var(--text-muted, #5b6370); text-decoration: line-through; }
        /* 任务复选框（可点击切换完成态） */
        .cm-task-box {
          display: inline-flex; align-items: center; justify-content: center;
          width: 15px; height: 15px; margin-right: 6px; vertical-align: -2px;
          border: 1.5px solid var(--border-strong, #b6bcc7); border-radius: 4px;
          cursor: pointer; user-select: none; flex: none;
        }
        .cm-task-box:hover { border-color: var(--accent, #0e7c6b); }
        .cm-task-box.done { background: var(--accent, #0e7c6b); border-color: var(--accent, #0e7c6b); }
        .cm-task-box.done::after { content: '✓'; color: var(--accent-text, #fff); font-size: 10px; line-height: 1; }
        .preview { flex: 1; overflow-y: auto; padding: 24px max(16px, calc(50% - 400px)); font-size: var(--font-size-sm, 13px); line-height: 1.7; color: var(--text, #1a1d23); background: var(--surface, #fff); }
        .preview h1, .preview h2, .preview h3, .preview h4 { margin: 1em 0 .5em; line-height: 1.35; }
        .preview h1 { font-size: 28px; border-bottom: 1px solid var(--border, #d9dce2); padding-bottom: .3em; }
        .preview h2 { font-size: 21px; }
        .preview h3 { font-size: 17px; }
        .preview p { margin: .6em 0; }
        .preview ul, .preview ol { margin: .6em 0; padding-left: 1.6em; }
        .preview blockquote { margin: .6em 0; padding: .2em 1em; border-left: 3px solid var(--accent, #0e7c6b); color: var(--text-muted, #5b6370); background: var(--surface-2, #eceef1); border-radius: var(--radius-sm, 4px); }
        .preview code { font-family: var(--font-mono, monospace); font-size: 12px; background: var(--surface-2, #eceef1); padding: .1em .4em; border-radius: var(--radius-sm, 4px); }
        .preview pre { background: var(--surface-2, #eceef1); padding: var(--space-3, 12px); border-radius: var(--radius-base, 6px); overflow-x: auto; }
        .preview pre code { background: none; padding: 0; }
        .preview table { border-collapse: collapse; margin: .6em 0; }
        .preview th, .preview td { border: 1px solid var(--border, #d9dce2); padding: 4px 10px; }
        .preview img { max-width: 100%; }
        .preview hr { border: none; border-top: 1px solid var(--border, #d9dce2); margin: 1em 0; }
        .preview a { color: var(--accent, #0e7c6b); }
        .preview .nav-hl, .nav-outline mark { background: #ffd54d; color: #3a2d00; border-radius: 2px; padding: 0 1px; font-weight: 600; }
        .nav-pane { flex: none; width: 220px; border-left: 1px solid var(--border, #d9dce2); background: var(--surface-2, #eceef1); display: flex; flex-direction: column; min-height: 0; }
        .nav-pane.hidden { display: none; }
        .nav-toolbar { padding: var(--space-2, 8px); border-bottom: 1px solid var(--border, #d9dce2); }
        .nav-toolbar .side-search { width: 100%; }
        .nav-outline { flex: 1; overflow-y: auto; padding: var(--space-2, 8px); }
        .nav-item { padding: 3px var(--space-2, 8px); border-radius: var(--radius-sm, 4px); cursor: pointer; font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .nav-item:hover { background: var(--surface, #fff); color: var(--text, #1a1d23); }
        .nav-item.on { color: var(--accent, #0e7c6b); }
        .nav-empty { padding: var(--space-2, 8px); font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); }
        /* 排序下拉 */
        .menu { position: absolute; z-index: 30; min-width: 132px; background: var(--surface, #fff); border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-base, 6px); box-shadow: var(--shadow-2, 0 6px 20px rgba(16,20,28,.12)); padding: 4px; display: none; }
        .menu.show { display: block; }
        .menu-item { padding: 6px var(--space-3, 12px); border-radius: var(--radius-sm, 4px); cursor: pointer; font-size: var(--font-size-sm, 13px); }
        .menu-item:hover { background: var(--surface-2, #eceef1); }
        .menu-item.on { color: var(--accent, #0e7c6b); }
        .menu-item { display: flex; align-items: center; gap: var(--space-2, 8px); }
        .menu-item svg { width: 14px; height: 14px; flex: none; }
        /* 右键菜单 */
        .ctx { position: absolute; z-index: 40; min-width: 108px; background: var(--surface, #fff); border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-base, 6px); box-shadow: var(--shadow-2, 0 6px 20px rgba(16,20,28,.12)); padding: 4px; display: none; }
        .ctx.show { display: block; }
        .ctx .menu-item { display: flex; align-items: center; gap: var(--space-2, 8px); }
        .ctx .menu-item svg { width: 14px; height: 14px; flex: none; }
        .ctx .menu-item.danger { color: var(--danger, #b3372e); }
        /* 弹层 */
        .overlay { position: absolute; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.25); }
        .overlay.show { display: flex; }
        .modal { width: 320px; background: var(--surface, #fff); border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-lg, 10px); box-shadow: var(--shadow-2, 0 6px 20px rgba(16,20,28,.12)); padding: var(--space-4, 16px); }
        .modal-title { margin: 0 0 var(--space-3, 12px); font-size: var(--font-size-base, 14px); font-weight: var(--font-weight-semibold, 600); }
        .modal-message { margin: 0 0 var(--space-3, 12px); font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); line-height: 1.5; word-break: break-all; }
        .modal input, .modal select { width: 100%; height: 30px; padding: 0 var(--space-2, 8px); border: 1px solid var(--border-strong, #b6bcc7); border-radius: var(--radius-base, 6px); background: var(--surface-2, #eceef1); color: var(--text, #1a1d23); font-size: var(--font-size-sm, 13px); outline: none; }
        .modal input:focus { border-color: var(--accent, #0e7c6b); box-shadow: 0 0 0 3px var(--focus-ring, rgba(14,124,107,.35)); }
        .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2, 8px); margin-top: var(--space-3, 12px); }
        .folder-list { max-height: 180px; overflow-y: auto; border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-base, 6px); background: var(--surface-2, #eceef1); padding: 2px; }
        .folder-opt { padding: 5px var(--space-2, 8px); border-radius: var(--radius-sm, 4px); cursor: pointer; font-size: var(--font-size-sm, 13px); color: var(--text, #1a1d23); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .folder-opt:hover { background: var(--surface, #fff); }
        .folder-opt.on { background: var(--accent, #0e7c6b); color: var(--accent-text, #fff); }
        .btn { height: 28px; padding: 0 var(--space-3, 12px); border: 1px solid var(--border-strong, #b6bcc7); border-radius: var(--radius-base, 6px); background: var(--surface, #fff); color: var(--text, #1a1d23); font-size: var(--font-size-sm, 13px); cursor: pointer; }
        .btn:hover { background: var(--surface-2, #eceef1); }
        .btn.primary { background: var(--accent, #0e7c6b); border-color: var(--accent, #0e7c6b); color: var(--accent-text, #fff); }
        .btn.primary:hover { background: var(--accent-hover, #0a6457); }
        .btn.danger { background: var(--danger, #b3372e); border-color: var(--danger, #b3372e); color: #fff; }
        .btn.danger:hover { background: var(--danger-hover, #932e26); }
        .btn:focus-visible { outline: 2px solid var(--focus-ring, rgba(14,124,107,.35)); outline-offset: 1px; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: var(--border-strong, #b6bcc7); border-radius: var(--radius-pill, 999px); }
        /* P2 语法扩展样式 */
        .preview .footnotes { margin-top: 2em; font-size: 12px; color: var(--text-muted, #5b6370); }
        .preview .footnotes ol { padding-left: 1.6em; }
        .preview .footnotes li { margin: .3em 0; }
        .preview .fn-ref { font-size: 10px; }
        .preview .fn-back { text-decoration: none; margin-left: .3em; }
        .preview dl { margin: .6em 0; }
        .preview dt { font-weight: 600; margin-top: .4em; }
        .preview dd { margin: 0 0 .3em 1.6em; }
        .preview .math-inline { white-space: nowrap; }
        .preview .math-block { text-align: center; margin: .8em 0; overflow-x: auto; }
        .preview .mermaid { margin: .8em 0; text-align: center; }
        .preview pre.mermaid-src { background: var(--surface-2, #eceef1); padding: var(--space-3, 12px); border-radius: var(--radius-base, 6px); overflow-x: auto; }
        .preview details { margin: .6em 0; padding: .4em .8em; border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-base, 6px); }
        .preview summary { cursor: pointer; font-weight: 600; }
        ${hljsTheme}
        ${katexCss}
`
