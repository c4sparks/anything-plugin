// 笔记知识库插件（个人知识库）：左右布局 + 文件夹/文件树 + 排序 + 展开收起 + 右键菜单
// 打包型外部插件：源码可 import npm 依赖（CodeMirror 6），由 scripts/build-plugin.mjs 打包为单文件 ESM。
// 数据：window.api.pluginFiles（契约 docs/插件契约.md §6），存 userData/plugin-data/notes/files/。
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment, Annotation } from '@codemirror/state'
import { Decoration, ViewPlugin, WidgetType, placeholder } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const PLUGIN_ID = 'notes'
const ROOT = ''
/** 侧栏折叠为窄条时的宽度（= 折叠/展开按钮宽度） */
const SIDE_COLLAPSED = 36
/** 分屏同文件多份时的内容同步标记：带此 annotation 的改动来自其他面板，不再转发/落盘 */
const Sync = Annotation.define()

/** 分屏树工具：摘除含 cardId 的叶子并就地折叠（split 只剩 1 孩子 → 用孩子替换自己） */
function removeLeaf(node, cardId) {
  if (!node) return null
  if (node.type === 'leaf') return node.cardId === cardId ? null : node
  const a = removeLeaf(node.children[0], cardId)
  const b = removeLeaf(node.children[1], cardId)
  if (a === null && b === null) return null
  if (a === null) return b
  if (b === null) return a
  return { type: 'split', dir: node.dir, children: [a, b] }
}

const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: '14px' },
    '.cm-scroller': { lineHeight: '1.7', scrollBehavior: 'smooth' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '0', maxWidth: '800px', margin: '0 auto', fontFamily: 'var(--font-ui)', fontSize: '14px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-activeLine': { backgroundColor: 'var(--surface-2)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-2)' },
    '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
    '.cm-lineNumbers .cm-gutterElement': { color: 'var(--text-muted)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--focus-ring)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--surface-2)', outline: '1px solid var(--border-strong)' },
    '.cm-placeholder': { color: 'var(--text-muted)', fontStyle: 'italic' },
  },
  { dark: false },
)

// 表格列分隔 `|` → 视觉分隔线 widget（保持单元格文字可编辑）
class TableSepWidget extends WidgetType {
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-live-tbl-sep'
    return s
  }
  eq(o) {
    return o instanceof TableSepWidget
  }
  ignoreEvent() {
    return false
  }
}

// 任务列表 `[ ]` / `[x]` → 可点击复选框 widget（点击切换完成态，记录原文范围）
class TaskBoxWidget extends WidgetType {
  constructor(done, from, to) {
    super()
    this.done = done
    this.from = from
    this.to = to
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-task-box' + (this.done ? ' done' : '')
    s.dataset.from = this.from
    s.dataset.to = this.to
    return s
  }
  eq(o) {
    return o instanceof TaskBoxWidget && o.done === this.done && o.from === this.from && o.to === this.to
  }
  ignoreEvent() {
    return true
  }
}

// 普通模式（所见即所得实时预览）：用 decoration 隐藏 markdown 语法标记、样式化标题/强调/链接等
const livePreviewExt = () =>
  ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view)
      }

      update(update) {
        if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view)
      }

      build(view) {
        const state = view.state
        const tree = syntaxTree(state)
        const decos = []
        const lineClasses = new Map() // lineNo -> cls
        const addMark = (from, to, cls) => decos.push(Decoration.mark({ class: cls }).range(from, to))
        const hideRange = (from, to) => decos.push(Decoration.replace({}).range(from, to))
        // 隐藏标记本身 + 其后空白（`# `、`- `、`> `、`1. `），让内容从行首开始
        const hideMarker = (markFrom, markTo, limit) => {
          const line = state.doc.lineAt(markTo)
          let end = markTo
          while (end < limit && end <= line.to && (state.sliceDoc(end, end + 1) === ' ' || state.sliceDoc(end, end + 1) === '\t')) end++
          hideRange(markFrom, end)
        }
        const lineCls = (lineNo, cls) => {
          lineClasses.set(lineNo, ((lineClasses.get(lineNo) || '') + ' ' + cls).trim())
        }
        tree.iterate({
          enter: (n) => {
            const name = n.name
            const m = /^ATXHeading([1-6])$/.exec(name)
            if (m) {
              let cur = n.node.firstChild
              while (cur) {
                if (cur.name === 'HeaderMark') hideMarker(cur.from, cur.to, n.to)
                cur = cur.nextSibling
              }
              lineCls(state.doc.lineAt(n.from).number, `cm-live-h${m[1]}`)
              return
            }
            if (name === 'Blockquote') {
              let cur = n.node.firstChild
              while (cur) {
                if (cur.name === 'QuoteMark') hideMarker(cur.from, cur.to, n.to)
                cur = cur.nextSibling
              }
              lineCls(state.doc.lineAt(n.from).number, 'cm-live-quote')
              return
            }
            if (name === 'ListItem') {
              let cur = n.node.firstChild
              while (cur) {
                if (cur.name === 'ListMark') hideMarker(cur.from, cur.to, n.to)
                cur = cur.nextSibling
              }
              return
            }
            if (name === 'StrongEmphasis' || name === 'Emphasis') {
              const cls = name === 'StrongEmphasis' ? 'cm-live-strong' : 'cm-live-em'
              const marks = []
              let cur = n.node.firstChild
              while (cur) {
                if (cur.name === 'EmphasisMark') marks.push([cur.from, cur.to])
                cur = cur.nextSibling
              }
              if (marks.length >= 2) {
                hideRange(marks[0][0], marks[0][1])
                hideRange(marks[marks.length - 1][0], marks[marks.length - 1][1])
                addMark(marks[0][1], marks[marks.length - 1][0], cls)
              }
              return
            }
            if (name === 'InlineCode') {
              const marks = []
              let cur = n.node.firstChild
              while (cur) {
                if (cur.name === 'CodeMark') marks.push([cur.from, cur.to])
                cur = cur.nextSibling
              }
              if (marks.length >= 2) {
                hideRange(marks[0][0], marks[0][1])
                hideRange(marks[marks.length - 1][0], marks[marks.length - 1][1])
                addMark(marks[0][1], marks[marks.length - 1][0], 'cm-live-code')
              }
              return
            }
            if (name === 'Link') {
              const pieces = []
              let cur = n.node.firstChild
              while (cur) {
                pieces.push(cur)
                cur = cur.nextSibling
              }
              let textStart = -1
              let textEnd = -1
              for (let i = 0; i < pieces.length; i++) {
                const p = pieces[i]
                if (p.name === 'LinkMark' && state.sliceDoc(p.from, p.to) === '[') {
                  textStart = p.to
                  hideRange(p.from, p.to)
                } else if (p.name === 'LinkMark' && state.sliceDoc(p.from, p.to) === ']') {
                  textEnd = p.from
                  hideRange(p.from, p.to)
                } else if (p.name === 'LinkMark' && state.sliceDoc(p.from, p.to) === '(') {
                  hideRange(p.from, p.to)
                } else if (p.name === 'LinkMark' && state.sliceDoc(p.from, p.to) === ')') {
                  hideRange(p.from, p.to)
                } else if (p.name === 'URL') {
                  hideRange(p.from, p.to)
                }
              }
              if (textStart >= 0 && textEnd > textStart) addMark(textStart, textEnd, 'cm-live-link')
              return
            }
            if (name === 'FencedCode') {
              let cur = n.node.firstChild
              while (cur) {
                if (cur.name === 'CodeMark') hideRange(cur.from, cur.to)
                cur = cur.nextSibling
              }
              const fromLine = state.doc.lineAt(n.from).number
              const toLine = state.doc.lineAt(Math.max(n.from, n.to - 1)).number
              for (let l = fromLine; l <= toLine; l++) lineCls(l, 'cm-live-codeblock')
              return
            }
            if (/^SetextHeading([12])$/.test(name)) {
              // 标题行 + 下划线行（HeaderMark）；隐藏下划线行，标题行加 h1/h2 样式
              const lvl = name === 'SetextHeading1' ? 1 : 2
              lineCls(state.doc.lineAt(n.from).number, `cm-live-h${lvl}`)
              let cur = n.node.firstChild
              while (cur) {
                if (cur.name === 'HeaderMark') {
                  const l = state.doc.lineAt(cur.from)
                  hideRange(l.from, l.to)
                }
                cur = cur.nextSibling
              }
              return
            }
            if (name === 'Strikethrough') {
              const marks = []
              let cur = n.node.firstChild
              while (cur) {
                if (cur.name === 'StrikethroughMark') marks.push([cur.from, cur.to])
                cur = cur.nextSibling
              }
              if (marks.length >= 2) {
                hideRange(marks[0][0], marks[0][1])
                hideRange(marks[marks.length - 1][0], marks[marks.length - 1][1])
                addMark(marks[0][1], marks[marks.length - 1][0], 'cm-live-del')
              }
              return
            }
            if (name === 'Task') {
              let cur = n.node.firstChild
              let done = false
              while (cur) {
                if (cur.name === 'TaskMarker') {
                  done = state.sliceDoc(cur.from, cur.to).includes('x')
                  decos.push(Decoration.replace({ widget: new TaskBoxWidget(done, cur.from, cur.to) }).range(cur.from, cur.to))
                }
                cur = cur.nextSibling
              }
              if (done) lineCls(state.doc.lineAt(n.from).number, 'cm-live-task-done')
              return
            }
            if (name === 'Table') {
              // 遍历后代：`|` 分隔符换 widget、`|---|` 分隔行整行隐藏、行加表格样式
              const walkTbl = (node) => {
                let cur = node.firstChild
                while (cur) {
                  if (cur.name === 'TableDelimiter') {
                    const txt = state.sliceDoc(cur.from, cur.to)
                    if (txt.length > 1 && /-/.test(txt)) {
                      const l = state.doc.lineAt(cur.from)
                      hideRange(l.from, l.to)
                    } else {
                      decos.push(Decoration.replace({ widget: new TableSepWidget() }).range(cur.from, cur.to))
                    }
                  } else if (cur.name === 'TableHeader') {
                    lineCls(state.doc.lineAt(cur.from).number, 'cm-live-table cm-live-table-head')
                    walkTbl(cur)
                  } else if (cur.name === 'TableRow') {
                    lineCls(state.doc.lineAt(cur.from).number, 'cm-live-table')
                    walkTbl(cur)
                  } else if (cur.name === 'TableCell') {
                    walkTbl(cur)
                  }
                  cur = cur.nextSibling
                }
              }
              walkTbl(n.node)
              return
            }
            if (name === 'Image') {
              const pieces = []
              let cur = n.node.firstChild
              while (cur) {
                pieces.push(cur)
                cur = cur.nextSibling
              }
              let textStart = -1
              let textEnd = -1
              for (const p of pieces) {
                if (p.name === 'LinkMark' && state.sliceDoc(p.from, p.to).startsWith('!')) {
                  textStart = p.to
                  hideRange(p.from, p.to)
                } else if (p.name === 'LinkMark' && state.sliceDoc(p.from, p.to) === ']') {
                  textEnd = p.from
                  hideRange(p.from, p.to)
                } else if (p.name === 'LinkMark' || p.name === 'URL') {
                  hideRange(p.from, p.to)
                }
              }
              if (textStart >= 0 && textEnd > textStart) addMark(textStart, textEnd, 'cm-live-img')
              return
            }
            if (name === 'Autolink') {
              let cur = n.node.firstChild
              let urlStart = -1
              let urlEnd = -1
              while (cur) {
                if (cur.name === 'LinkMark') hideRange(cur.from, cur.to)
                if (cur.name === 'URL') {
                  urlStart = cur.from
                  urlEnd = cur.to
                }
                cur = cur.nextSibling
              }
              if (urlStart >= 0) addMark(urlStart, urlEnd, 'cm-live-link')
              return
            }
            if (name === 'HorizontalRule') {
              const l = state.doc.lineAt(n.from)
              hideRange(l.from, l.to)
              lineCls(l.number, 'cm-live-hr')
              return
            }
            if (name === 'CodeBlock') {
              const fromLine = state.doc.lineAt(n.from).number
              const toLine = state.doc.lineAt(Math.max(n.from, n.to - 1)).number
              for (let l = fromLine; l <= toLine; l++) lineCls(l, 'cm-live-codeblock')
              return
            }
            if (name === 'LinkReference') {
              // 参考链接定义行 `[id]: url` 整行隐藏
              const l = state.doc.lineAt(n.from)
              hideRange(l.from, l.to)
              return
            }
            if (name === 'LinkLabel') {
              // 参考式链接 `[文字][id]` 的 `[id]` 隐藏
              hideRange(n.from, n.to)
              return
            }
          },
        })
        for (const [ln, cls] of lineClasses) {
          decos.push(Decoration.line({ class: cls }).range(state.doc.line(ln).from))
        }
        return Decoration.set(decos, true)
      }
    },
    { decorations: (v) => v.decorations },
  )

const SORT_OPTIONS = [
  { key: 'name', dir: 1, label: '文件名 升序' },
  { key: 'name', dir: -1, label: '文件名 降序' },
  { key: 'created', dir: 1, label: '创建时间 升序' },
  { key: 'created', dir: -1, label: '创建时间 降序' },
  { key: 'modified', dir: 1, label: '修改时间 升序' },
  { key: 'modified', dir: -1, label: '修改时间 降序' },
]

class NotesApp extends HTMLElement {
  constructor() {
    super()
    this.tree = new Map() // 目录 key(''=根) -> entries[]
    this.expanded = new Set()
    this.selectedFolder = ROOT // 新文件/夹落点
    this.selectedItem = null // 树中选中项（文件/夹 path）
    // 多开面板模型：panes = 所有打开的笔记（标签）；分屏按「卡片」分组，每张卡片自带独立标签栏
    this.panes = new Map() // paneId -> { id, cardId, path, editor, saveTimer, liveCompartment, live }
    this.cards = new Map() // cardId -> { id, paneIds:[], activePaneId }
    this.splitRoot = null // null=单卡片 | {type:'split',dir,children:[leaf,leaf]}（叶子为 cardId）
    this.activePaneId = null // 当前激活标签
    this.activeCardId = null // 当前聚焦卡片
    this.lastActivePaneId = null
    this.nextPaneId = 1
    this.nextCardId = 1
    this.filter = ''
    this.sortKey = 'name'
    this.sortDir = 1
    this.sideCollapsed = false
    this.sideWidth = 260
    this.morePaneId = null // 更多菜单当前作用的面板 id
    this.previewTimer = null
    this.context = null // {x,y,path,kind}
    this.dialog = null // {title, mode:'input'|'folder'|'confirm', resolve, message?}
  }

  get activePane() {
    return this.activePaneId ? this.panes.get(this.activePaneId) ?? null : null
  }

  /** 激活面板的笔记路径（向后兼容旧 `this.current` 读法；ESM strict 下不可赋值，所有赋值点已改写） */
  get current() {
    return this.activePane?.path ?? null
  }

  connectedCallback() {
    this.attachShadow({ mode: 'open' })
    this.renderShell()
    this.bind()
    this.renderSplit() // 初始无面板：显示全局占位
    this.updateHead()
    void this.loadDir(ROOT)
  }

  disconnectedCallback() {
    clearTimeout(this.previewTimer)
    for (const rec of this.panes.values()) {
      clearTimeout(rec.saveTimer)
      if (rec.path && rec.editor) {
        const content = rec.editor.state.doc.toString() // 先捕获内容再写（fire-and-forget）
        window.api.pluginFiles.write(PLUGIN_ID, rec.path, content).catch(() => {})
      }
      rec.editor?.destroy()
    }
    this.panes.clear()
  }

  // ---------- 渲染 ----------
  renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
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
        .search-clear {
          position: absolute; top: 50%; right: 3px; transform: translateY(-50%);
          width: 18px; height: 18px; display: none; align-items: center; justify-content: center;
          border: none; border-radius: 50%; background: var(--border-strong, #b6bcc7); color: var(--surface, #fff);
          cursor: pointer; padding: 0;
        }
        .search-clear:hover { background: var(--text-muted, #5b6370); }
        .search-clear svg { width: 10px; height: 10px; }
        .search-clear.show { display: inline-flex; }
        .tree { flex: 1; overflow-y: auto; padding: 4px; }
        .t-row {
          display: flex; align-items: center; gap: var(--space-1, 4px);
          padding: 4px var(--space-1, 4px); border-radius: var(--radius-base, 6px);
          cursor: pointer; font-size: var(--font-size-sm, 13px); color: var(--text, #1a1d23);
          white-space: nowrap; user-select: none;
        }
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
        .card-nav-toolbar { display: flex; align-items: center; gap: var(--space-1, 4px); padding: var(--space-2, 8px); border-bottom: 1px solid var(--border, #d9dce2); }
        .card-nav-search { flex: 1; width: 100%; height: 24px; padding: 0 var(--space-2, 8px); border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-pill, 999px); background: var(--surface, #fff); color: var(--text, #1a1d23); font-size: var(--font-size-xs, 12px); outline: none; }
        .card-nav-search:focus { border-color: var(--accent, #0e7c6b); box-shadow: 0 0 0 2px var(--focus-ring, rgba(14,124,107,.35)); }
        .card-nav-clear { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 50%; background: var(--border-strong, #b6bcc7); color: var(--surface, #fff); cursor: pointer; padding: 0; font-size: 11px; line-height: 1; }
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
      </style>
      <div class="app">
        <aside class="side">
          <div class="toolbar">
            <button class="icon-btn" data-act="new-file" title="新增文件" aria-label="新增文件">${ICON_FILE}</button>
            <button class="icon-btn" data-act="new-folder" title="新增文件夹" aria-label="新增文件夹">${ICON_FOLDER}</button>
            <button class="icon-btn" data-act="sort" title="排序" aria-label="排序">${ICON_SORT}</button>
            <button class="icon-btn" data-act="expand" title="展开/收起" aria-label="展开收起">${ICON_EXPAND}</button>
            <button type="button" class="icon-btn" data-act="toggle-side" title="折叠左侧" aria-label="折叠左侧">${ICON_PANEL_LEFT}</button>
          </div>
          <div class="tree" data-tree></div>
        </aside>
        <div class="splitter" data-splitter title="拖动调整宽度"></div>
        <section class="editor">
          <div class="editor-body">
            <div class="main" data-split-root></div>
          </div>
        </section>
        <div class="menu" data-sort-menu></div>
        <div class="menu" data-more-menu style="min-width:150px"></div>
        <div class="drag-hint" data-drag-hint></div>
        <div class="ctx" data-ctx></div>
        <div class="overlay" data-overlay>
          <div class="modal">
            <h4 class="modal-title" data-modal-title></h4>
            <p class="modal-message" data-modal-message hidden></p>
            <input type="text" data-modal-input spellcheck="false" hidden />
            <select data-modal-select hidden></select>
            <div class="folder-list" data-modal-folderlist hidden></div>
            <div class="modal-actions">
              <button type="button" class="btn" data-modal-cancel>取消</button>
              <button type="button" class="btn primary" data-modal-ok>确定</button>
            </div>
          </div>
        </div>
      </div>
    `
  }

  bind() {
    const root = this.shadowRoot
    root.querySelector('[data-act="new-file"]').addEventListener('click', () => this.newEntry('file'))
    root.querySelector('[data-act="new-folder"]').addEventListener('click', () => this.newEntry('folder'))
    root.querySelector('[data-act="sort"]').addEventListener('click', (e) => this.toggleSortMenu(e))
    root.querySelector('[data-act="expand"]').addEventListener('click', () => this.toggleExpandAll())
    root.querySelector('[data-act="toggle-side"]').addEventListener('click', () => this.toggleSide())
    root.querySelector('[data-more-menu]').addEventListener('click', (e) => {
      const item = e.target.closest('[data-more-act]')
      if (!item) return
      const act = item.dataset.moreAct
      this.hideMoreMenu()
      this.moreAction(act, this.morePaneId)
    })
    root.querySelector('[data-splitter]').addEventListener('mousedown', (e) => this.startSplitDrag(e))
    const splitRoot = root.querySelector('[data-split-root]')
    // 卡片内事件委托：标签切换/关闭、新建、更多、点击聚焦、拖拽（标签栏=多开，内容=插链接）
    splitRoot.addEventListener('click', (e) => {
      const card = e.target.closest('[data-card-id]')
      if (!card) return
      const cardId = card.dataset.cardId
      if (e.target.closest('.card-nav-clear')) {
        e.stopPropagation()
        const c = this.cards.get(cardId)
        if (c) {
          c.navQuery = ''
          this.applyNavHighlight(c)
          this.renderOutline(c)
          const input = this.shadowRoot.querySelector(`[data-card-nav-search="${cardId}"]`)
          if (input) input.value = ''
        }
        return
      }
      if (e.target.closest('[data-card-nav-idx]')) {
        const c = this.cards.get(cardId)
        const entry = c?.outline[Number(e.target.closest('[data-card-nav-idx]').dataset.cardNavIdx)]
        if (entry?.el) entry.el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }
      if (e.target.closest('.ctab-close')) {
        e.stopPropagation()
        void this.closePane(e.target.closest('.ctab-close').dataset.cardTabClose)
        return
      }
      if (e.target.closest('.ctab-new')) {
        void this.newNoteFromPane(this.cards.get(cardId)?.activePaneId)
        return
      }
      const tab = e.target.closest('[data-card-tab]')
      if (tab) {
        this.activatePane(tab.dataset.cardTab) // 点标签只切换，不关闭
        return
      }
      if (e.target.closest('.card-more')) {
        const paneId = this.cards.get(cardId)?.activePaneId
        if (paneId) {
          this.activeCardId = cardId // 聚焦该卡片，分屏/模式作用到它
          this.morePaneId = paneId
          this.toggleMoreMenu(e.target.closest('.card-more'), paneId)
        }
        return
      }
      const paneId = this.cards.get(cardId)?.activePaneId
      if (paneId) this.activatePane(paneId) // 点卡片其它区域 → 聚焦该卡片激活标签
    })
    // 卡片导航搜索输入：实时过滤该卡片的预览高亮 + 大纲
    splitRoot.addEventListener('input', (e) => {
      const search = e.target.closest('[data-card-nav-search]')
      if (!search) return
      const c = this.cards.get(search.dataset.cardNavSearch)
      if (!c) return
      c.navQuery = search.value.trim().toLowerCase()
      this.applyNavHighlight(c)
      this.renderOutline(c)
    })
    splitRoot.addEventListener('focusin', (e) => {
      const card = e.target.closest('[data-card-id]')
      if (!card) return
      const paneId = this.cards.get(card.dataset.cardId)?.activePaneId
      if (paneId) this.activatePane(paneId)
    })
    splitRoot.addEventListener('mousedown', (e) => {
      const divider = e.target.closest('.split-divider')
      if (!divider) return
      e.preventDefault()
      this.startDividerDrag(e, divider)
    })
    // capture：抢在 CodeMirror 自身的 drop/dragover 之前处理，避免编辑器把路径当文本插入
    splitRoot.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      const card = e.target.closest('[data-card-id]')
      const hint = this.shadowRoot.querySelector('[data-drag-hint]')
      if (card && hint) {
        hint.textContent = e.target.closest('.card-tabs, .card-page') ? '打开为新标签' : '插入链接'
        hint.style.left = e.clientX + 10 + 'px'
        hint.style.top = e.clientY + 16 + 'px'
        hint.classList.add('show')
      }
    }, { capture: true })
    splitRoot.addEventListener('dragleave', (e) => {
      const card = e.target.closest('[data-card-id]')
      if (card && !card.contains(e.relatedTarget)) {
        const hint = this.shadowRoot.querySelector('[data-drag-hint]')
        if (hint) hint.classList.remove('show')
      }
    })
    splitRoot.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const path = e.dataTransfer.getData('text/plain')
      const hint = this.shadowRoot.querySelector('[data-drag-hint]')
      if (hint) hint.classList.remove('show')
      if (!path) return
      const card = e.target.closest('[data-card-id]')
      if (!card) {
        void this.openNote(path) // 空容器 → 打开到激活卡片
        return
      }
      const cardId = card.dataset.cardId
      const paneId = this.cards.get(cardId)?.activePaneId
      if (e.target.closest('.card-tabs, .card-page')) {
        // 拖到卡片标签栏/路径栏 → 在该卡片多开（插到激活标签后面）
        void this.openAsTab(path, paneId)
        return
      }
      // 内容区 → 按落点插入链接（空标签退化为打开）
      if (paneId) void this.insertLinkAt(paneId, path, e.clientX, e.clientY)
    }, { capture: true })
    root.querySelector('[data-tree]').addEventListener('dragstart', (e) => {
      const row = e.target.closest('[data-path]')
      if (!row || row.dataset.kind !== 'file') return
      e.dataTransfer.setData('text/plain', row.dataset.path)
      e.dataTransfer.effectAllowed = 'copy'
    })
    root.querySelector('[data-tree]').addEventListener('click', (e) => {
      const row = e.target.closest('[data-path]')
      if (!row) {
        this.selectFolder(ROOT) // 点击文件树空白处 = 回到根
        return
      }
      const path = row.dataset.path
      const kind = row.dataset.kind
      if (kind === 'folder') this.selectFolder(path)
      else void this.openNote(path)
    })
    root.querySelector('[data-tree]').addEventListener('contextmenu', (e) => {
      const row = e.target.closest('[data-path]')
      if (!row || row.dataset.kind === 'root') return
      e.preventDefault()
      this.showContext(e, row.dataset.path, row.dataset.kind)
    })
    root.querySelector('[data-sort-menu]').addEventListener('click', (e) => {
      const item = e.target.closest('[data-opt]')
      if (!item) return
      const opt = SORT_OPTIONS[Number(item.dataset.opt)]
      this.sortKey = opt.key
      this.sortDir = opt.dir
      this.renderTree()
      this.hideSortMenu()
    })
    root.querySelector('[data-ctx]').addEventListener('click', (e) => {
      const item = e.target.closest('[data-ctx-act]')
      if (!item) return
      const act = item.dataset.ctxAct
      const c = this.context
      this.hideContext()
      if (c) this.ctxAction(act, c.path, c.kind)
    })
    root.querySelector('[data-modal-cancel]').addEventListener('click', () => this.closeDialog(null))
    root.querySelector('[data-modal-ok]').addEventListener('click', () => this.confirmDialog())
    root.querySelector('[data-modal-folderlist]').addEventListener('click', (e) => {
      const opt = e.target.closest('[data-folder-opt]')
      if (!opt) return
      root.querySelectorAll('[data-folder-opt]').forEach((o) => o.classList.toggle('on', o === opt))
      if (this.dialog) this.dialog.folderValue = opt.dataset.folderOpt
    })
    root.querySelector('[data-modal-input]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirmDialog()
      if (e.key === 'Escape') this.closeDialog(null)
    })
    root.querySelector('[data-overlay]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirmDialog()
      if (e.key === 'Escape') this.closeDialog(null)
    })
    root.addEventListener('click', (e) => {
      if (!e.target.closest('[data-sort-menu]') && !e.target.closest('[data-act="sort"]')) this.hideSortMenu()
      if (!e.target.closest('[data-more-menu]') && !e.target.closest('[data-head-act="more"]') && !e.target.closest('.card-more')) this.hideMoreMenu()
      if (!e.target.closest('[data-ctx]')) this.hideContext()
    })
    root.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('[data-tree]')) this.hideContext()
    })
  }

  // ---------- 树 ----------
  async loadDir(dir) {
    try {
      const entries = await window.api.pluginFiles.list(PLUGIN_ID, dir === ROOT ? undefined : dir)
      // 防御：主进程契约返回正斜杠路径，这里再归一化一次，避免 Windows 反斜杠破坏 `/` 路径逻辑
      this.tree.set(dir, entries.map((x) => ({ ...x, path: x.path.replace(/\\/g, '/') })))
      this.renderTree()
    } catch (err) {
      console.error('[notes] loadDir', dir, err)
    }
  }

  sortEntries(entries) {
    const a = [...entries]
    const keyOf = (x) => (this.sortKey === 'created' ? x.createdMs : this.sortKey === 'modified' ? x.mtimeMs : x.name)
    a.sort((x, y) => {
      const va = keyOf(x)
      const vb = keyOf(y)
      const c = typeof va === 'string' ? va.localeCompare(vb, 'zh-CN') : va - vb
      if (x.isDirectory !== y.isDirectory) return x.isDirectory ? -1 : 1 // 文件夹永远在前
      return c * this.sortDir
    })
    return a
  }

  renderTree() {
    const tree = this.shadowRoot.querySelector('[data-tree]')
    const q = this.filter
    const lines = []
    const fileMatches = (x) => x.name.toLowerCase().includes(q)
    const dirHasMatch = (path) => {
      const entries = this.sortEntries(this.tree.get(path) || [])
      return entries.some((x) => x.isDirectory ? dirHasMatch(x.path) : fileMatches(x))
    }
    const highlight = (text) => {
      if (!q) return this.escapeHtml(text)
      const lower = text.toLowerCase()
      const parts = []
      let i = 0
      let idx = lower.indexOf(q)
      while (idx !== -1) {
        if (idx > i) parts.push(this.escapeHtml(text.slice(i, idx)))
        parts.push(`<mark>${this.escapeHtml(text.slice(idx, idx + q.length))}</mark>`)
        i = idx + q.length
        idx = lower.indexOf(q, i)
      }
      if (i < text.length) parts.push(this.escapeHtml(text.slice(i)))
      return parts.join('')
    }
    const walk = (dir, depth) => {
      const entries = this.sortEntries(this.tree.get(dir) || [])
      for (const x of entries) {
        if (!q) {
          // 无搜索：正常渲染
        } else if (x.isDirectory) {
          if (!fileMatches(x) && !dirHasMatch(x.path)) continue // 文件夹自身或后代无匹配则隐藏
          if (this.expanded.has(x.path) && !this.tree.has(x.path)) void this.loadDir(x.path) // 保证结果可见
        } else if (!fileMatches(x)) {
          continue
        }
        const isFolder = x.isDirectory
        const indent = 'padding-left:' + (depth * 14 + 4) + 'px'
        const caret = isFolder ? (this.expanded.has(x.path) ? '▾' : '▸') : ''
        const cls = ['t-row']
        if (isFolder) cls.push('folder')
        if (this.selectedItem === x.path) cls.push('sel')
        if (!isFolder && this.current === x.path) cls.push('cur')
        lines.push(
          `<div class="${cls.join(' ')}" style="${indent}" data-path="${this.escapeAttr(x.path)}" data-kind="${isFolder ? 'folder' : 'file'}" title="${this.escapeAttr(x.path)}" ${isFolder ? '' : 'draggable="true"'}>
            <span class="caret">${caret}</span>
            <span class="ic">${isFolder ? ICON_FOLDER_SM : ICON_DOC_SM}</span>
            <span class="nm">${highlight(x.name.replace(/\.md$/, ''))}</span>
          </div>`,
        )
        if (isFolder && this.expanded.has(x.path)) walk(x.path, depth + 1)
      }
    }
    walk(ROOT, 0)
    if (!lines.length) {
      tree.innerHTML = `<div class="t-empty">${q ? '没有匹配项。' : '还没有内容。点上方按钮新建。'}</div>`
      return
    }
    tree.innerHTML = lines.join('')
  }

  async selectFolder(path) {
    if (path === ROOT) {
      this.selectedFolder = ROOT
      this.selectedItem = ROOT
      this.renderTree()
      return
    }
    this.selectedFolder = path
    this.selectedItem = path
    if (!this.expanded.has(path)) {
      this.expanded.add(path)
      if (!this.tree.has(path)) await this.loadDir(path)
      else this.renderTree()
    } else {
      this.expanded.delete(path)
      this.renderTree()
    }
  }

  toggleExpandAll() {
    const allFolders = this.collectFolders()
    const allExpanded = allFolders.every((p) => this.expanded.has(p))
    if (allExpanded) {
      this.expanded.clear()
      this.renderTree()
      this.setExpandIcon(false)
      return
    }
    const loadChain = allFolders.map((p) => this.loadDir(p))
    allFolders.forEach((p) => this.expanded.add(p))
    Promise.all(loadChain).catch(() => {})
    this.setExpandIcon(true)
  }

  setExpandIcon(expanded) {
    const btn = this.shadowRoot.querySelector('[data-act="expand"]')
    if (!btn) return
    btn.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND
    btn.title = expanded ? '全部收起' : '全展开'
    btn.setAttribute('aria-label', btn.title)
  }

  toggleSide() {
    this.sideCollapsed = !this.sideCollapsed
    const side = this.shadowRoot.querySelector('.side')
    const btn = this.shadowRoot.querySelector('[data-act="toggle-side"]')
    const splitter = this.shadowRoot.querySelector('[data-splitter]')
    if (this.sideCollapsed) {
      side.classList.add('collapsed') // 折叠为窄条（只留按钮），非 display:none
      splitter.style.display = 'none'
      btn.innerHTML = ICON_PANEL_RIGHT
      btn.title = '展开左侧'
    } else {
      side.classList.remove('collapsed')
      splitter.style.display = ''
      btn.innerHTML = ICON_PANEL_LEFT
      btn.title = '折叠左侧'
      this.renderTree()
    }
    btn.setAttribute('aria-label', btn.title)
  }

  startSplitDrag(e) {
    e.preventDefault()
    const splitter = this.shadowRoot.querySelector('[data-splitter]')
    const side = this.shadowRoot.querySelector('.side')
    const appRect = this.shadowRoot.querySelector('.app').getBoundingClientRect()
    splitter.classList.add('dragging')
    document.body.style.userSelect = 'none'
    const onMove = (ev) => {
      // 最小宽度 = 折叠按钮窄条宽度（36px），再左拖即贴到最窄
      // 侧栏宽度自适应：上限整宽 40% 且 ≤400px，保证笔记页面始终有足够显示空间
      const width = Math.min(Math.max(ev.clientX - appRect.left, SIDE_COLLAPSED), Math.round(appRect.width * 0.4), 400)
      side.style.width = width + 'px'
      this.sideWidth = width
    }
    const onUp = () => {
      splitter.classList.remove('dragging')
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 设置面板显示模式（normal 实时预览 / source 源码 / preview 渲染预览），各面板独立 */
  setPaneMode(paneId, mode) {
    const rec = this.panes.get(paneId)
    if (!rec) return
    if (rec.mode === mode) {
      this.renderMoreMenu(paneId)
      return
    }
    rec.mode = mode
    const cardEl = this.shadowRoot.querySelector(`[data-card-id="${rec.cardId}"]`)
    if (cardEl) cardEl.dataset.mode = mode
    if (rec.editor && rec.liveCompartment) {
      rec.live = mode === 'normal'
      rec.editor.dispatch({ effects: rec.liveCompartment.reconfigure(rec.live ? livePreviewExt() : []) })
    }
    if (mode === 'preview') this.renderPreview(paneId)
    this.updateHead()
    this.renderMoreMenu(paneId)
    rec.editor?.focus()
  }

  /** 分屏：把当前卡片在当前笔记处一分为二（并排/上下）。左卡片保留原全部标签，右卡片只有当前笔记一个标签 */
  async splitActive(dir) {
    const card = this.ensureCard()
    const active = this.panes.get(card.activePaneId)
    if (!active) return
    const newCard = this.createCard() // 右/下卡片：只含当前笔记
    const dup = this.addTab(newCard.id)
    dup.mode = active.mode
    const splitNode = { type: 'split', dir, children: [{ type: 'leaf', cardId: card.id }, { type: 'leaf', cardId: newCard.id }] }
    if (this.splitRoot) this.replaceLeaf(card.id, splitNode)
    else this.splitRoot = splitNode
    this.activeCardId = newCard.id
    this.activePaneId = dup.id
    this.updateHead()
    this.renderSplit()
    if (active.path) await this.openInPane(dup.id, active.path)
    this.renderMoreMenu()
  }

  /** 分屏树工具：把含 cardId 的叶子替换为 newNode（递归） */
  replaceLeaf(cardId, newNode) {
    const replace = (node) => {
      if (node.type === 'leaf') return node.cardId === cardId ? newNode : node
      const a = replace(node.children[0])
      const b = replace(node.children[1])
      if (a !== node.children[0] || b !== node.children[1]) node.children = [a, b]
      return node
    }
    this.splitRoot = replace(this.splitRoot)
  }

  /** 分屏分割线拖动：调整该 split 层级两侧面板的大小（左右/上下） */
  startDividerDrag(e, divider) {
    e.preventDefault()
    const split = divider.parentElement
    if (!split) return
    const dir = split.dataset.dir
    const first = split.children[0]
    const splitRect = split.getBoundingClientRect()
    const min = 80
    const max = dir === 'row' ? splitRect.width : splitRect.height
    divider.classList.add('dragging')
    document.body.style.userSelect = 'none'
    const onMove = (ev) => {
      const raw = dir === 'row' ? ev.clientX - splitRect.left : ev.clientY - splitRect.top
      const size = Math.max(min, Math.min(raw, max - min))
      first.style.flex = `0 0 ${size}px`
      if (split._splitNode) split._splitNode.firstSize = size // 存到节点，重建 DOM 后保持
    }
    const onUp = () => {
      divider.classList.remove('dragging')
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  toggleMoreMenu(anchor, paneId) {
    const menu = this.shadowRoot.querySelector('[data-more-menu]')
    if (menu.classList.contains('show')) {
      this.hideMoreMenu()
      return
    }
    this.renderMoreMenu(paneId)
    const host = this.shadowRoot.querySelector('.app').getBoundingClientRect()
    const rect = anchor.getBoundingClientRect()
    menu.style.left = Math.max(0, rect.right - host.left - 160) + 'px'
    menu.style.top = rect.bottom - host.top + 4 + 'px'
    menu.classList.add('show')
  }

  renderMoreMenu(paneId) {
    const menu = this.shadowRoot.querySelector('[data-more-menu]')
    const items = [
      { act: 'normal', label: '普通模式', icon: ICON_EDIT },
      { act: 'source', label: '源文件', icon: ICON_SOURCE },
      { act: 'preview', label: '预览', icon: ICON_EYE },
      { act: 'split', label: '左右分屏', icon: ICON_SPLIT_H },
      { act: 'split-v', label: '上下分屏', icon: ICON_SPLIT_V },
      { act: 'nav', label: '导航', icon: ICON_NAV },
    ]
    menu.innerHTML = items
      .map(
        (x) =>
          `<div class="menu-item${this.moreActive(x.act, paneId) ? ' on' : ''}" data-more-act="${x.act}">${x.icon}<span>${x.label}</span></div>`,
      )
      .join('')
  }

  moreActive(act, paneId) {
    if (act === 'nav') {
      const pane = this.panes.get(paneId)
      return pane ? this.cards.get(pane.cardId)?.navOpen : false
    }
    const pane = this.panes.get(paneId ?? this.activePaneId)
    return pane?.mode === act
  }

  moreAction(act, paneId) {
    if (act === 'normal' || act === 'source' || act === 'preview') return this.setPaneMode(paneId, act)
    if (act === 'split') return this.splitActive('row')
    if (act === 'split-v') return this.splitActive('column')
    if (act === 'nav') return this.toggleNav(this.panes.get(paneId)?.cardId)
  }

  hideMoreMenu() {
    this.shadowRoot.querySelector('[data-more-menu]').classList.remove('show')
  }

  toggleNav(cardId) {
    const card = this.cards.get(cardId) ?? this.ensureCard()
    card.navOpen = !card.navOpen
    if (card.navOpen) this.renderPreview(card.activePaneId)
    this.renderSplit()
    this.renderMoreMenu()
  }

  renderPreview(paneId) {
    const rec = this.panes.get(paneId ?? this.activePaneId)
    if (!rec) return
    const card = this.cards.get(rec.cardId)
    const target = card ? this.panes.get(card.activePaneId) : rec
    if (!target) return
    const preview = this.shadowRoot.querySelector(`[data-card-id="${rec.cardId}"] [data-preview]`)
    if (!preview) return
    const content = target.editor?.state.doc.toString() ?? ''
    const raw = content ? marked.parse(content) : ''
    const safe = content ? DOMPurify.sanitize(raw) : ''
    preview.innerHTML = safe
    // 该卡片导航开着 → 应用该卡片自己的搜索高亮 + 重建大纲
    if (card && card.navOpen && target.id === card.activePaneId) {
      this.applyNavHighlight(card)
      this.renderOutline(card)
    }
  }

  /** 在指定卡片的预览上高亮该卡片的搜索词 */
  applyNavHighlight(card) {
    const q = card.navQuery
    if (!q) return
    const target = this.panes.get(card.activePaneId)
    if (!target) return
    const preview = this.shadowRoot.querySelector(`[data-card-id="${card.id}"] [data-preview]`)
    if (!preview) return
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT)
    const targets = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.parentElement?.closest('pre, code, script, style')) continue
      if (!node.parentElement?.closest('h1,h2,h3,h4,h5,h6')) continue // 导航只搜标题内容
      targets.push(node)
    }
    for (const node of targets) {
      const text = node.textContent
      const lower = text.toLowerCase()
      let idx = lower.indexOf(q)
      if (idx === -1) continue
      const frag = document.createDocumentFragment()
      let i = 0
      while (idx !== -1) {
        if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)))
        const mark = document.createElement('mark')
        mark.className = 'nav-hl'
        mark.textContent = text.slice(idx, idx + q.length)
        frag.appendChild(mark)
        i = idx + q.length
        idx = lower.indexOf(q, i)
      }
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)))
      node.parentNode.replaceChild(frag, node)
    }
  }

  /** 重建指定卡片的标题大纲（按该卡片搜索词过滤标题，命中高亮），渲染到该卡片的导航区 */
  renderOutline(card) {
    const target = this.panes.get(card.activePaneId)
    if (!target) return
    const preview = this.shadowRoot.querySelector(`[data-card-id="${card.id}"] [data-preview]`)
    if (!preview) return
    card.outline = [...preview.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((el) => ({
      el,
      level: Number(el.tagName[1]),
      text: el.textContent || '',
    }))
    const box = this.shadowRoot.querySelector(`[data-card-nav-outline="${card.id}"]`)
    if (!box) return
    const q = card.navQuery
    if (!card.outline.length) {
      box.innerHTML = '<div class="nav-empty">暂无标题大纲。</div>'
      return
    }
    const hl = (text) => {
      if (!q) return this.escapeHtml(text)
      const lower = text.toLowerCase()
      const parts = []
      let i = 0
      let idx = lower.indexOf(q)
      while (idx !== -1) {
        if (idx > i) parts.push(this.escapeHtml(text.slice(i, idx)))
        parts.push(`<mark>${this.escapeHtml(text.slice(idx, idx + q.length))}</mark>`)
        i = idx + q.length
        idx = lower.indexOf(q, i)
      }
      if (i < text.length) parts.push(this.escapeHtml(text.slice(i)))
      return parts.join('')
    }
    const items = card.outline.map((o, i) => ({ o, i })).filter(({ o }) => !q || o.text.toLowerCase().includes(q))
    if (!items.length) {
      box.innerHTML = '<div class="nav-empty">没有匹配的标题。</div>'
      return
    }
    box.innerHTML = items
      .map(
        ({ o, i }) =>
          `<div class="nav-item" data-card-nav-idx="${i}" style="padding-left:${(o.level - 1) * 12 + 8}px">${hl(o.text)}</div>`,
      )
      .join('')
  }

  collectFolders() {
    const out = []
    const walk = (dir) => {
      for (const x of this.tree.get(dir) || []) {
        if (x.isDirectory) {
          out.push(x.path)
          if (this.tree.has(x.path)) walk(x.path)
        }
      }
    }
    walk(ROOT)
    return out
  }

  // ---------- 新增 ----------
  async newEntry(kind) {
    const label = kind === 'folder' ? '新建文件夹' : '新建笔记'
    const value = await this.openInputDialog(label, kind === 'folder' ? '文件夹名…' : '笔记标题…', '')
    if (value == null || !value) return
    const base = this.selectedFolder && this.selectedFolder !== ROOT ? this.selectedFolder + '/' : ''
    const rel = kind === 'folder' ? base + value : base + value + '.md'
    try {
      if (kind === 'folder') {
        await window.api.pluginFiles.mkdir(PLUGIN_ID, rel)
        this.expanded.add(this.selectedFolder)
        await this.loadDir(this.selectedFolder)
        this.selectFolder(rel)
      } else {
        await window.api.pluginFiles.write(PLUGIN_ID, rel, `# ${value}\n`)
        await this.loadDir(this.selectedFolder)
        await this.openNote(rel)
      }
    } catch (err) {
      console.error('[notes] 创建失败（可能已存在）', err)
    }
  }

  /** 卡片标签栏 +：在该卡片里新建笔记（在该卡片新开一个标签） */
  async newNoteFromPane(paneId) {
    const rec = this.panes.get(paneId) ?? this.ensurePane()
    if (!rec) return
    const card = this.cards.get(rec.cardId) ?? this.ensureCard()
    const value = await this.openInputDialog('新建笔记', '笔记标题…', '')
    if (value == null || !value) return
    // 目录 = 该标签笔记所在目录（无笔记则用当前选中目录）
    const dir = rec.path && rec.path.includes('/') ? rec.path.slice(0, rec.path.lastIndexOf('/')) : rec.path ? ROOT : this.selectedFolder
    const rel = (dir && dir !== ROOT ? dir + '/' : '') + value + '.md'
    try {
      await window.api.pluginFiles.write(PLUGIN_ID, rel, `# ${value}\n`)
      await this.loadDir(dir)
      const tab = this.addTab(card.id) // 在该卡片新开标签
      this.activeCardId = card.id
      this.activePaneId = tab.id
      this.updateHead()
      this.renderSplit()
      await this.openInPane(tab.id, rel)
    } catch (err) {
      console.error('[notes] 新建失败（可能已存在）', err)
    }
  }

  // ---------- 打开/编辑 ----------
  async openNote(path) {
    // 已打开 → 切到对应标签/卡片
    for (const rec of this.panes.values()) {
      if (rec.path === path) {
        this.activatePane(rec.id)
        return
      }
    }
    // 未打开 → 在当前激活卡片里新开一个标签（旧标签全部保留）
    const card = this.ensureCard()
    const tab = this.addTab(card.id)
    this.activeCardId = card.id
    this.activePaneId = tab.id
    this.updateHead()
    this.renderSplit()
    await this.openInPane(tab.id, path)
  }

  /** 多开：在 afterPaneId 所在卡片里新开一个标签（插到该页签之后）；已打开则切到其标签 */
  async openAsTab(path, afterPaneId = null) {
    for (const rec of this.panes.values()) {
      if (rec.path === path) {
        this.activatePane(rec.id)
        return
      }
    }
    const afterRec = afterPaneId ? this.panes.get(afterPaneId) : null
    const card = afterRec ? (this.cards.get(afterRec.cardId) ?? this.ensureCard()) : this.ensureCard()
    const tab = this.createPane()
    tab.cardId = card.id
    const idx = afterPaneId ? card.paneIds.indexOf(afterPaneId) : -1
    if (idx >= 0) card.paneIds.splice(idx + 1, 0, tab.id)
    else card.paneIds.push(tab.id)
    card.activePaneId = tab.id
    this.activeCardId = card.id
    this.activePaneId = tab.id
    this.updateHead()
    this.renderSplit()
    await this.openInPane(tab.id, path)
  }

  // ---------- 多开拆分面板 ----------
  updatePaneTitle(paneId) {
    this.renderSplit() // 卡片标签/路径随重渲染刷新（重命名/移动/换笔记时）
  }

  /** 重渲染卡片（标签栏/路径栏都在卡片内） */
  updateHead() {
    this.renderSplit()
  }

  /** 渲染 .main：普通态渲染当前卡片；分屏态渲染卡片树。渲染后刷新各卡片预览/导航 */
  renderSplit() {
    const main = this.shadowRoot.querySelector('[data-split-root]')
    if (!main) return
    main.innerHTML = ''
    if (this.splitRoot) {
      main.appendChild(this.renderSplitNode(this.splitRoot))
    } else {
      const card = this.activeCard
      if (!card || card.paneIds.length === 0) {
        main.innerHTML = '<div class="placeholder">选择或新建一篇笔记开始。</div>'
      } else {
        main.appendChild(this.renderCard(card.id))
      }
    }
    // 预览模式或导航开着的卡片：重渲染预览/大纲（markdown 预览、搜索高亮）
    for (const card of this.cards.values()) {
      const active = this.panes.get(card.activePaneId)
      if (active && (active.mode === 'preview' || card.navOpen)) this.renderPreview(active.id)
    }
  }

  renderSplitNode(node) {
    if (node.type === 'leaf') return this.renderCard(node.cardId)
    const div = document.createElement('div')
    div.className = 'split'
    div.dataset.dir = node.dir
    div._splitNode = node // 记住节点引用，拖动时回写大小比例
    const first = this.renderSplitNode(node.children[0])
    if (node.firstSize) first.style.flex = `0 0 ${node.firstSize}px` // 重建 DOM 后保持拖动的大小
    div.appendChild(first)
    const divider = document.createElement('div') // 可拖拽分割线
    divider.className = 'split-divider'
    div.appendChild(divider)
    div.appendChild(this.renderSplitNode(node.children[1]))
    return div
  }

  /** 渲染一张分屏卡片：自带标签栏（多标签+新建）+ 路径栏 + 编辑器（激活标签）+ 预览 */
  renderCard(cardId) {
    const card = this.cards.get(cardId)
    const el = document.createElement('div')
    el.className = 'card' + (cardId === this.activeCardId ? ' active' : '')
    el.dataset.cardId = cardId
    if (!card || card.paneIds.length === 0) {
      el.innerHTML = '<div class="placeholder">选择或新建一篇笔记开始。</div>'
      return el
    }
    const pane = this.panes.get(card.activePaneId)
    el.dataset.mode = pane?.mode ?? 'normal' // 显示模式（normal/source/preview）随激活标签
    // 卡片标签栏：该卡片打开的笔记页签 + 新建
    const tabs = document.createElement('div')
    tabs.className = 'card-tabs'
    tabs.innerHTML =
      card.paneIds
        .map((id) => {
          const r = this.panes.get(id)
          const name = r?.path ? r.path.split('/').pop().replace(/\.md$/, '') : '分屏'
          const active = id === card.activePaneId
          return `<span class="ctab${active ? ' active' : ''}" data-card-tab="${id}" title="${this.escapeAttr(r?.path ?? '')}"><span class="ctab-name">${this.escapeHtml(name)}</span><button type="button" class="ctab-close" data-card-tab-close="${id}" title="关闭" aria-label="关闭">×</button></span>`
        })
        .join('') +
      '<button type="button" class="ctab-new" data-card-new title="在该卡片新建笔记" aria-label="新建笔记">' + ICON_PLUS + '</button>'
    el.appendChild(tabs)
    // 卡片路径栏
    const page = document.createElement('div')
    page.className = 'card-page'
    page.innerHTML = `<span class="card-crumb">${pane?.path ? this.escapeHtml(pane.path.replace(/\.md$/, '')) : ''}</span><button type="button" class="card-more" data-card-more title="更多" aria-label="更多">${ICON_MORE}</button>`
    el.appendChild(page)
    // 编辑器 + 预览（左侧）+ 卡片导航（右侧，可选，每卡片独立搜索+大纲）
    const body = document.createElement('div')
    body.className = 'card-body'
    const editorCol = document.createElement('div')
    editorCol.className = 'card-editor'
    const cm = document.createElement('div')
    cm.className = 'cm-wrap'
    cm.dataset.editor = ''
    if (pane?.editor) {
      cm.appendChild(pane.editor.dom) // 复用编辑器实例，不重建
    } else {
      const holder = document.createElement('div')
      holder.className = 'placeholder'
      holder.textContent = '拖入笔记到此处打开。'
      cm.appendChild(holder)
    }
    editorCol.appendChild(cm)
    const preview = document.createElement('div')
    preview.className = 'preview'
    preview.dataset.preview = ''
    // 预览模式：直接内联渲染 markdown 预览（重渲染后不依赖额外调用）
    if (pane?.mode === 'preview') {
      const content = pane.editor?.state.doc.toString() ?? ''
      preview.innerHTML = content ? DOMPurify.sanitize(marked.parse(content)) : ''
    }
    editorCol.appendChild(preview)
    body.appendChild(editorCol)
    if (card.navOpen) {
      const nav = document.createElement('div')
      nav.className = 'card-nav'
      nav.innerHTML =
        `<div class="card-nav-toolbar"><input class="card-nav-search" data-card-nav-search="${card.id}" value="${this.escapeAttr(card.navQuery)}" placeholder="搜索…" spellcheck="false" /><button type="button" class="card-nav-clear" data-card-nav-clear="${card.id}" title="清除搜索" aria-label="清除搜索">×</button></div>` +
        `<div class="card-nav-outline" data-card-nav-outline="${card.id}"></div>`
      body.appendChild(nav)
    }
    el.appendChild(body)
    return el
  }

  /** 当前分屏树里的所有卡片 id（无分屏 → 空 Set） */
  splitCardIds() {
    const ids = new Set()
    if (!this.splitRoot) return ids
    const walk = (n) => (n.type === 'leaf' ? ids.add(n.cardId) : n.children.forEach(walk))
    walk(this.splitRoot)
    return ids
  }

  /** 判断 paneId 所在的卡片是否在分屏树里 */
  splitContains(paneId) {
    const rec = this.panes.get(paneId)
    if (!rec) return false
    return this.splitCardIds().has(rec.cardId)
  }

  createPane() {
    const rec = { id: 'pane-' + this.nextPaneId++, cardId: null, path: null, mode: 'normal', editor: null, saveTimer: null, liveCompartment: null, live: false }
    this.panes.set(rec.id, rec)
    return rec
  }

  /** 新建一张分屏卡片（含独立标签栏） */
  createCard() {
    const card = { id: 'card-' + this.nextCardId++, paneIds: [], activePaneId: null, navOpen: false, navQuery: '', outline: [] }
    this.cards.set(card.id, card)
    return card
  }

  /** 保证至少一张卡片存在且 activeCardId 有效 */
  ensureCard() {
    if (this.cards.size === 0) {
      const card = this.createCard()
      this.activeCardId = card.id
      return card
    }
    if (!this.activeCardId || !this.cards.has(this.activeCardId)) {
      this.activeCardId = [...this.cards.keys()][0]
    }
    return this.cards.get(this.activeCardId)
  }

  /** 在指定卡片里新增一个标签（返回新 pane），并把该卡片的激活标签设为新标签 */
  addTab(cardId) {
    const card = this.cards.get(cardId) ?? this.ensureCard()
    const rec = this.createPane()
    rec.cardId = card.id
    card.paneIds.push(rec.id)
    card.activePaneId = rec.id
    return rec
  }

  get activeCard() {
    return this.activeCardId ? this.cards.get(this.activeCardId) ?? null : null
  }

  /** 保证至少一个标签存在，且 activePaneId / activeCardId 有效 */
  ensurePane() {
    const card = this.ensureCard()
    if (card.paneIds.length === 0) {
      this.addTab(card.id)
    } else if (!card.activePaneId || !this.panes.has(card.activePaneId)) {
      card.activePaneId = card.paneIds[0]
    }
    if (!this.activePaneId || !this.panes.has(this.activePaneId)) {
      this.activePaneId = card.activePaneId
    }
    this.activeCardId = card.id
    return this.panes.get(this.activePaneId)
  }

  /** 关闭标签：落盘（可 discard）→ 从卡片移除；卡片只剩一页关掉 → 该卡片/分屏关闭；激活重指派 */
  async closePane(paneId, { discard = false } = {}) {
    const rec = this.panes.get(paneId)
    if (!rec) return
    clearTimeout(rec.saveTimer)
    if (!discard && rec.path && rec.editor) {
      try {
        await window.api.pluginFiles.write(PLUGIN_ID, rec.path, rec.editor.state.doc.toString())
      } catch {
        /* 落盘失败忽略 */
      }
    }
    rec.editor?.destroy()
    this.panes.delete(paneId)
    const card = this.cards.get(rec.cardId)
    if (card) {
      card.paneIds = card.paneIds.filter((id) => id !== paneId)
      if (card.paneIds.length === 0) {
        // 卡片已空 → 删除卡片；分屏树就地折叠；只剩单卡片 → 回到单卡片模式
        this.cards.delete(card.id)
        if (this.splitRoot) {
          const collapsed = removeLeaf(this.splitRoot, card.id)
          if (collapsed && collapsed.type === 'split') this.splitRoot = collapsed
          else this.splitRoot = null
        }
        if (this.activeCardId === card.id) {
          this.activeCardId = [...this.cards.keys()][0] ?? null
          this.activePaneId = this.activeCardId ? this.cards.get(this.activeCardId).activePaneId : null
        }
      } else {
        if (card.activePaneId === paneId) card.activePaneId = card.paneIds[0]
        if (this.activeCardId === card.id) this.activePaneId = card.activePaneId
      }
    }
    if (this.lastActivePaneId === paneId) this.lastActivePaneId = null
    if (this.panes.size === 0) {
      this.activePaneId = null
      this.activeCardId = null
      this.splitRoot = null
      this.renderSplit()
      this.updateHead()
      this.renderTree()
      this.renderPreview()
      return
    }
    this.renderSplit()
    this.updateHead()
    this.activePane?.editor?.focus()
    this.renderTree()
    this.renderPreview()
  }

  /** 打开 path 到指定标签（替换其内容），并设为该卡片激活标签 */
  async openInPane(paneId, path) {
    const rec = this.panes.get(paneId)
    if (!rec) return
    const card = this.cards.get(rec.cardId)
    if (card) card.activePaneId = rec.id
    await this.savePane(paneId)
    let content
    try {
      content = await window.api.pluginFiles.read(PLUGIN_ID, path)
    } catch (err) {
      console.error('[notes] 打开失败', path, err)
      return
    }
    // 已有标签打开同一文件时，用其内存中最新内容（分屏复制/二次打开避免读到旧落盘）
    const live = [...this.panes.values()].find((r) => r.id !== paneId && r.path === path && r.editor)
    if (live) content = live.editor.state.doc.toString()
    rec.editor?.destroy()
    rec.path = path
    this.selectedItem = path
    const host = this.shadowRoot.querySelector(`[data-card-id="${rec.cardId}"] [data-editor]`)
    if (!host) this.renderSplit() // 卡片 DOM 缺失（理论不发生）则补渲染
    this.createEditorForPane(paneId, content)
    if (paneId === this.activePaneId) {
      this.updateHead()
      this.renderTree()
      this.renderPreview(paneId)
    }
    rec.editor?.focus()
  }

  /** 拖到内容区：在鼠标落点插入 markdown 链接（拖到哪插到哪）；空面板退化为打开 */
  insertLinkAt(paneId, path, clientX, clientY) {
    const rec = this.panes.get(paneId)
    if (!rec) return
    if (!rec.path) return this.openInPane(paneId, path)
    if (!rec.editor) return
    const pos = rec.editor.posAtCoords({ x: clientX, y: clientY }) ?? rec.editor.state.selection.main.head
    const title = path.split('/').pop().replace(/\.md$/, '')
    const link = `[${title}](${path})`
    rec.editor.dispatch({
      changes: { from: pos, to: pos, insert: link },
      selection: { anchor: pos + link.length },
    })
    rec.editor.focus()
  }

  /** 切换激活标签：聚焦所在卡片并设其激活标签、重渲染（卡片内标签/路径刷新） */
  activatePane(paneId) {
    if (!this.panes.has(paneId) || paneId === this.activePaneId) return
    this.lastActivePaneId = this.activePaneId
    this.activePaneId = paneId
    const card = this.cards.get(this.panes.get(paneId).cardId)
    if (card) {
      card.activePaneId = paneId
      this.activeCardId = card.id
    }
    this.updateHead()
    this.renderSplit()
    this.renderTree()
    this.renderPreview(paneId)
    this.panes.get(paneId)?.editor?.focus()
  }

  // ---------- 每面板编辑器与保存 ----------
  createEditorForPane(paneId, doc) {
    const rec = this.panes.get(paneId)
    const host = this.shadowRoot.querySelector(`[data-card-id="${rec?.cardId}"] [data-editor]`)
    if (!rec || !host) return
    host.innerHTML = ''
    const content = typeof doc === 'string' ? doc : ''
    rec.liveCompartment = new Compartment()
    rec.live = rec.mode === 'normal' // 各面板独立显示模式
    rec.editor = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          markdown({ base: markdownLanguage }), // GFM：表格/任务列表/删除线/自动链接/上下标等
          editorTheme,
          placeholder('开始输入…'),
          rec.liveCompartment.of(rec.live ? livePreviewExt() : []),
          EditorView.domEventHandlers({
            mousedown: (e, view) => {
              // 点击任务复选框：切换 `[ ]` ↔ `[x]`，不移动光标
              const box = e.target.closest('.cm-task-box')
              if (!box) return false
              const from = Number(box.dataset.from)
              const to = Number(box.dataset.to)
              const text = view.state.sliceDoc(from, to)
              const next = text.includes('x') ? text.replace('x', ' ') : text.replace(' ', 'x')
              view.dispatch({ changes: { from, to, insert: next } })
              e.preventDefault()
              e.stopPropagation()
              return true
            },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            // 外部同步来的改动（其他分屏面板的编辑）：不转发、不由本面板落盘
            const external = u.transactions.some((tr) => tr.annotation(Sync))
            if (external) {
              if (this.needsLivePreview(rec)) this.schedulePreviewPane(paneId)
              return
            }
            // 本地编辑：转发给打开同一文件的其他面板，保持各份实时一致
            this.syncPaneToOthers(paneId, u.transactions)
            this.scheduleSavePane(paneId)
            // 预览模式或该卡片导航开着 → 实时刷新预览/大纲/全文搜索
            if (this.needsLivePreview(rec)) this.schedulePreviewPane(paneId)
          }),
        ],
      }),
      parent: host,
    })
  }

  /** 把某面板的改动同步给打开同一文件的其他面板（分屏多份实时一致） */
  syncPaneToOthers(paneId, transactions) {
    const src = this.panes.get(paneId)
    if (!src?.path || !transactions.length) return
    for (const [id, rec] of this.panes) {
      if (id === paneId || rec.path !== src.path || !rec.editor) continue
      for (const tr of transactions) {
        rec.editor.dispatch({ changes: tr.changes, annotations: Sync.of(true) })
      }
    }
  }

  scheduleSavePane(paneId) {
    const rec = this.panes.get(paneId)
    if (!rec) return
    clearTimeout(rec.saveTimer)
    rec.saveTimer = setTimeout(() => void this.savePane(paneId), 600)
  }

  /** 预览模式或卡片导航开着时，才需要实时刷新预览/大纲/全文搜索 */
  needsLivePreview(rec) {
    const card = rec ? this.cards.get(rec.cardId) : null
    return !!rec && (rec.mode === 'preview' || !!card?.navOpen)
  }

  schedulePreviewPane(paneId) {
    clearTimeout(this.previewTimer)
    this.previewTimer = setTimeout(() => {
      const rec = this.panes.get(paneId)
      if (this.needsLivePreview(rec)) this.renderPreview(paneId)
    }, 300)
  }

  async savePane(paneId) {
    const rec = this.panes.get(paneId)
    if (!rec) return
    clearTimeout(rec.saveTimer) // 取消防抖定时器：避免删除/切换后旧定时器把文件写回
    if (!rec.path || !rec.editor) return
    try {
      await window.api.pluginFiles.write(PLUGIN_ID, rec.path, rec.editor.state.doc.toString())
    } catch (err) {
      console.error('[notes] 保存失败', err)
    }
  }

  saveAll() {
    return Promise.all([...this.panes.keys()].map((id) => this.savePane(id)))
  }

  /** 兼容旧调用点：保存激活面板 */
  saveCurrent() {
    return this.activePaneId ? this.savePane(this.activePaneId) : Promise.resolve()
  }

  // ---------- 排序 ----------
  toggleSortMenu(e) {
    const menu = this.shadowRoot.querySelector('[data-sort-menu]')
    if (menu.classList.contains('show')) {
      this.hideSortMenu()
      return
    }
    menu.innerHTML = SORT_OPTIONS.map(
      (o, i) =>
        `<div class="menu-item${this.sortKey === o.key && this.sortDir === o.dir ? ' on' : ''}" data-opt="${i}">${o.label}</div>`,
    ).join('')
    const host = this.shadowRoot.querySelector('.app').getBoundingClientRect()
    const rect = e.currentTarget.getBoundingClientRect()
    menu.style.left = rect.left - host.left + 'px'
    menu.style.top = rect.bottom - host.top + 4 + 'px'
    menu.classList.add('show')
  }

  hideSortMenu() {
    this.shadowRoot.querySelector('[data-sort-menu]').classList.remove('show')
  }

  // ---------- 右键菜单 ----------
  showContext(e, path, kind) {
    this.context = { path, kind }
    const ctx = this.shadowRoot.querySelector('[data-ctx]')
    ctx.innerHTML = [
      { act: 'copy', label: '复制', icon: ICON_CTX_COPY },
      { act: 'move', label: '移动', icon: ICON_CTX_MOVE },
      { act: 'rename', label: '重命名', icon: ICON_CTX_RENAME },
      { act: 'delete', label: '删除', icon: ICON_CTX_DELETE },
    ]
      .map((x) => `<div class="menu-item${x.act === 'delete' ? ' danger' : ''}" data-ctx-act="${x.act}">${x.icon}<span>${x.label}</span></div>`)
      .join('')
    const host = this.shadowRoot.querySelector('.app').getBoundingClientRect()
    ctx.style.left = Math.min(e.clientX - host.left, host.width - 120) + 'px'
    ctx.style.top = Math.min(e.clientY - host.top, host.height - 150) + 'px'
    ctx.classList.add('show')
  }

  ctxLabel(a) {
    return { copy: '复制', move: '移动', rename: '重命名', delete: '删除' }[a]
  }

  hideContext() {
    this.context = null
    this.shadowRoot.querySelector('[data-ctx]').classList.remove('show')
  }

  async ctxAction(act, path, kind) {
    if (act === 'delete') {
      const display = path.split('/').pop().replace(/\.md$/, '')
      const ok = await this.openConfirmDialog('删除', `确定删除「${display}」？此操作不可恢复。`)
      if (!ok) return
      await this.saveAll() // 先全部落盘，避免删除后防抖写回
      try {
        await window.api.pluginFiles.remove(PLUGIN_ID, path)
      } catch (err) {
        console.error('[notes] 删除失败', err)
        return
      }
      try {
        // 关闭所有打开该路径/其后代的面板（discard 防写回）
        for (const [id, rec] of [...this.panes]) {
          if (rec.path && (rec.path === path || rec.path.startsWith(path + '/'))) {
            await this.closePane(id, { discard: true })
          }
        }
        if (this.panes.size === 0) this.resetEditor()
        // 清理展开状态残留（删除的文件夹及其后代）
        for (const p of [...this.expanded]) if (p === path || p.startsWith(path + '/')) this.expanded.delete(p)
        if (this.selectedItem === path || (this.selectedItem && this.selectedItem.startsWith(path + '/'))) this.selectedItem = ROOT
      } catch (err) {
        console.error('[notes] 删除后清理异常', err)
      } finally {
        // 无论清理是否异常，都强制刷新父目录，避免树节点残留
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT
        await this.loadDir(parent)
      }
      return
    }
    if (act === 'rename') {
      await this.renameEntry(path)
      return
    }
    if (act === 'copy') {
      await this.copyEntry(path)
      return
    }
    if (act === 'move') {
      await this.saveAll()
      const folders = await this.collectAllFolders()
      const display = path.split('/').pop().replace(/\.md$/, '')
      const target = await this.openFolderDialog(`移动「${display}」到`, folders, path)
      if (target == null) return
      const newPath = (target ? target + '/' : '') + path.split('/').pop()
      if (newPath === path) return
      try {
        await window.api.pluginFiles.move(PLUGIN_ID, path, newPath)
        // 打开该路径/后代的面板：重写路径前缀并刷新标题
        for (const rec of this.panes.values()) {
          if (rec.path && (rec.path === path || rec.path.startsWith(path + '/'))) {
            rec.path = newPath + rec.path.slice(path.length)
            this.updatePaneTitle(rec.id)
          }
        }
        if (this.selectedItem && (this.selectedItem === path || this.selectedItem.startsWith(path + '/'))) {
          this.selectedItem = newPath + this.selectedItem.slice(path.length)
        }
        if (target) {
          this.expanded.add(target) // 移动后自动展开目标文件夹，让文件立即可见
        }
        await this.loadDir(ROOT)
        await this.loadDir(target)
      } catch (err) {
        console.error('[notes] 移动失败', err)
      }
    }
  }

  async renameEntry(path) {
    await this.saveAll()
    const name = path.split('/').pop()
    const isMd = name.endsWith('.md')
    const value = await this.openInputDialog('重命名', '新名称', isMd ? name.slice(0, -3) : name)
    if (value == null || !value) return
    const bare = isMd ? value.replace(/\.md$/i, '') : value
    if (bare === name.replace(/\.md$/, '')) return
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT
    const newPath = (parent ? parent + '/' : '') + bare + (isMd ? '.md' : '')
    try {
      await window.api.pluginFiles.move(PLUGIN_ID, path, newPath)
      // 打开该路径/后代的面板：重写路径前缀并刷新标题
      for (const rec of this.panes.values()) {
        if (rec.path && (rec.path === path || rec.path.startsWith(path + '/'))) {
          rec.path = newPath + rec.path.slice(path.length)
          this.updatePaneTitle(rec.id)
        }
      }
      if (this.selectedItem && (this.selectedItem === path || this.selectedItem.startsWith(path + '/'))) {
        this.selectedItem = newPath + this.selectedItem.slice(path.length)
      }
      await this.loadDir(parent)
    } catch (err) {
      console.error('[notes] 重命名失败', err)
    }
  }

  async copyEntry(path) {
    const name = path.split('/').pop()
    const isMd = name.endsWith('.md')
    const value = await this.openInputDialog('复制', '新名称', (isMd ? name.slice(0, -3) : name) + '-副本')
    if (value == null || !value) return
    const bare = isMd ? value.replace(/\.md$/i, '') : value
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT
    const newPath = (parent ? parent + '/' : '') + bare + (isMd ? '.md' : '')
    if (newPath === path) return
    try {
      await window.api.pluginFiles.copy(PLUGIN_ID, path, newPath)
      await this.loadDir(parent)
    } catch (err) {
      console.error('[notes] 复制失败', err)
    }
  }

  resetEditor() {
    for (const rec of this.panes.values()) {
      clearTimeout(rec.saveTimer)
      if (rec.path && rec.editor) {
        const content = rec.editor.state.doc.toString() // 先捕获内容再写（fire-and-forget）
        window.api.pluginFiles.write(PLUGIN_ID, rec.path, content).catch(() => {})
      }
      rec.editor?.destroy()
    }
    this.panes.clear()
    this.cards.clear()
    this.splitRoot = null
    this.activePaneId = null
    this.activeCardId = null
    this.lastActivePaneId = null
    this.filter = ''
    clearTimeout(this.previewTimer)
    this.renderSplit() // 回全局占位
    this.updateHead()
    const editor = this.shadowRoot.querySelector('.editor')
    editor.classList.remove('mode-normal', 'mode-source', 'mode-preview', 'mode-split', 'mode-split-v')
    editor.classList.add('mode-normal')
    this.renderMoreMenu()
  }

  async collectAllFolders() {
    const out = []
    const walk = async (dir) => {
      const entries = await window.api.pluginFiles.list(PLUGIN_ID, dir === ROOT ? undefined : dir)
      this.tree.set(dir, entries)
      for (const x of entries) {
        if (x.isDirectory) {
          out.push(x.path)
          await walk(x.path)
        }
      }
    }
    await walk(ROOT)
    return out
  }

  // ---------- 弹层 ----------
  openInputDialog(title, placeholder, value) {
    return new Promise((resolve) => {
      this.dialog = { title, mode: 'input', resolve }
      const ov = this.shadowRoot.querySelector('[data-overlay]')
      this.shadowRoot.querySelector('[data-modal-title]').textContent = title
      this.shadowRoot.querySelector('[data-modal-message]').hidden = true
      const input = this.shadowRoot.querySelector('[data-modal-input]')
      input.hidden = false
      input.placeholder = placeholder
      input.value = value
      input.focus()
      input.select()
      this.shadowRoot.querySelector('[data-modal-select]').hidden = true
      this.shadowRoot.querySelector('[data-modal-folderlist]').hidden = true
      const ok = this.shadowRoot.querySelector('[data-modal-ok]')
      ok.classList.remove('danger')
      ok.textContent = '确定'
      ov.classList.add('show')
    })
  }

  openFolderDialog(title, folders, excludePath) {
    return new Promise((resolve) => {
      this.dialog = { title, mode: 'folder', resolve, folderValue: '' }
      const ov = this.shadowRoot.querySelector('[data-overlay]')
      this.shadowRoot.querySelector('[data-modal-title]').textContent = title
      this.shadowRoot.querySelector('[data-modal-message]').hidden = true
      const input = this.shadowRoot.querySelector('[data-modal-input]')
      input.hidden = true
      this.shadowRoot.querySelector('[data-modal-folderlist]').hidden = true
      const sel = this.shadowRoot.querySelector('[data-modal-select]')
      sel.hidden = true
      const list = this.shadowRoot.querySelector('[data-modal-folderlist]')
      const depth = (f) => (f ? f.split('/').length : 0)
      const shortName = (f) => (f ? f.split('/').pop() : '根目录')
      list.innerHTML =
        '<div class="folder-opt on" data-folder-opt="">根目录</div>' +
        folders
          .filter((f) => f !== excludePath && !(excludePath && f.startsWith(excludePath + '/')))
          .map((f) => `<div class="folder-opt" data-folder-opt="${this.escapeAttr(f)}" style="padding-left:${depth(f) * 14 + 8}px">${this.escapeHtml(shortName(f))}</div>`)
          .join('')
      list.hidden = false
      const ok = this.shadowRoot.querySelector('[data-modal-ok]')
      ok.classList.remove('danger')
      ok.textContent = '确定'
      ov.classList.add('show')
    })
  }

  openConfirmDialog(title, message) {
    return new Promise((resolve) => {
      this.dialog = { title, mode: 'confirm', resolve }
      const ov = this.shadowRoot.querySelector('[data-overlay]')
      this.shadowRoot.querySelector('[data-modal-title]').textContent = title
      const msg = this.shadowRoot.querySelector('[data-modal-message]')
      msg.textContent = message
      msg.hidden = false
      const input = this.shadowRoot.querySelector('[data-modal-input]')
      input.hidden = true
      this.shadowRoot.querySelector('[data-modal-select]').hidden = true
      this.shadowRoot.querySelector('[data-modal-folderlist]').hidden = true
      const ok = this.shadowRoot.querySelector('[data-modal-ok]')
      ok.classList.add('danger')
      ok.textContent = '删除'
      ok.focus()
      ov.classList.add('show')
    })
  }

  confirmDialog() {
    if (!this.dialog) return
    const { resolve } = this.dialog
    const input = this.shadowRoot.querySelector('[data-modal-input]')
    const sel = this.shadowRoot.querySelector('[data-modal-select]')
    const value = this.dialog.mode === 'confirm' ? true : this.dialog.mode === 'folder' ? this.dialog.folderValue : input.hidden ? sel.value : input.value.trim()
    this.dialog = null
    this.shadowRoot.querySelector('[data-overlay]').classList.remove('show')
    resolve(value)
  }

  closeDialog() {
    if (!this.dialog) return
    const { resolve } = this.dialog
    this.dialog = null
    this.shadowRoot.querySelector('[data-overlay]').classList.remove('show')
    resolve(null)
  }

  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }

  escapeAttr(s) {
    return this.escapeHtml(s).replace(/`/g, '&#96;')
  }
}

const ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>'
const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="M9 14h6"/></svg>'
const ICON_SORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5h10"/><path d="M11 9h7"/><path d="M11 13h4"/><path d="M3 17l3 3 3-3"/><path d="M6 18V4"/></svg>'
const ICON_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l5 5 5-5"/><path d="M7 12l5 5 5-5"/></svg>'
const ICON_COLLAPSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18l5-5 5 5"/><path d="M7 6l5 5 5-5"/></svg>'
// 与壳层 AppIcon 'panel' 同几何（rect+divider+chevron）：折叠/展开侧栏统一图标（见 docs/设计规范.md 图标一致性）
const ICON_PANEL_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M13 9l3 3-3 3"/></svg>'
const ICON_PANEL_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M11 9l-3 3 3 3"/></svg>'
const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>'
const ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>'
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>'
const ICON_SOURCE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6l-5 6 5 6"/><path d="M16 6l5 6-5 6"/></svg>'
const ICON_SPLIT_H = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>'
const ICON_SPLIT_V = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/></svg>'
const ICON_NAV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/><circle cx="8" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="18" r="1" fill="currentColor" stroke="none"/></svg>'
const ICON_CTX_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const ICON_CTX_MOVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M16 12l3 3-3 3"/><path d="M19 15H10"/></svg>'
const ICON_CTX_RENAME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>'
const ICON_CTX_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'
const ICON_FOLDER_SM = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
const ICON_DOC_SM = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>'

customElements.define('app-plugin-notes', NotesApp)


