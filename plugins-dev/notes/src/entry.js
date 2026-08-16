// 笔记知识库插件（个人知识库）：左右布局 + 文件夹/文件树 + 排序 + 展开收起 + 右键菜单
// 打包型外部插件：源码可 import npm 依赖（CodeMirror 6），由 scripts/build-plugin.mjs 打包为单文件 ESM。
// 数据：window.api.pluginFiles（契约 docs/插件契约.md §6），存 userData/plugin-data/notes/files/。
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const PLUGIN_ID = 'notes'
const ROOT = ''

const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)', lineHeight: '1.6' },
    '.cm-content': { caretColor: 'var(--accent)', padding: 'var(--space-4) 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-activeLine': { backgroundColor: 'var(--surface-2)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-2)' },
    '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
    '.cm-lineNumbers .cm-gutterElement': { color: 'var(--text-muted)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--focus-ring)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--surface-2)', outline: '1px solid var(--border-strong)' },
    '.cm-placeholder': { color: 'var(--text-muted)' },
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
                  hideMarker(cur.from, cur.to, n.to)
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
    this.current = null // 当前编辑笔记 path
    this.editor = null
    this.saveTimer = null
    this.filter = ''
    this.sortKey = 'name'
    this.sortDir = 1
    this.sideCollapsed = false
    this.sideWidth = 260
    this.viewMode = 'normal' // normal(实时预览) | source(源码) | preview | split | split-v
    this.live = true // 编辑器是否处于所见即所得（普通模式）
    this.liveCompartment = null
    this.editorB = null // 分屏 B 面板编辑器（源码视图）
    this.paneBPath = null
    this.paneBSaveTimer = null
    this.navOpen = false // 导航面板默认隐藏，点「更多 → 导航」显示/关闭
    this.navQuery = ''
    this.outline = [] // [{el, level, text}]
    this.previewTimer = null
    this.context = null // {x,y,path,kind}
    this.dialog = null // {title, mode:'input'|'folder'|'confirm', resolve, message?}
  }

  connectedCallback() {
    this.attachShadow({ mode: 'open' })
    this.renderShell()
    this.bind()
    void this.loadDir(ROOT)
  }

  disconnectedCallback() {
    clearTimeout(this.saveTimer)
    clearTimeout(this.previewTimer)
    clearTimeout(this.paneBSaveTimer)
    if (this.current) void this.saveCurrent()
    if (this.paneBPath && this.editorB) {
      window.api.pluginFiles.write(PLUGIN_ID, this.paneBPath, this.editorB.state.doc.toString()).catch(() => {})
    }
    this.editor?.destroy()
    this.editorB?.destroy()
    this.editor = null
    this.editorB = null
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
        .editor-head {
          display: flex; align-items: center; gap: var(--space-2, 8px);
          padding: 4px 8px;
          border-bottom: 1px solid var(--border, #d9dce2);
          font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); min-height: 34px;
        }
        .editor-head .note-name { font-size: var(--font-size-base, 14px); font-weight: var(--font-weight-semibold, 600); color: var(--text, #1a1d23); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .head-actions { display: none; align-items: center; gap: var(--space-1, 4px); }
        .head-actions.show { display: inline-flex; }
        .head-actions .icon-btn { width: 28px; height: 28px; }
        .head-actions .icon-btn.on { color: var(--accent, #0e7c6b); background: var(--surface-2, #eceef1); }
        .editor-body { flex: 1; min-height: 0; display: flex; }
        .main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
        .main > * { min-width: 0; min-height: 0; }
        .pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
        .pane-head { display: flex; align-items: center; gap: var(--space-1, 4px); padding: 2px 8px; border-bottom: 1px solid var(--border, #d9dce2); font-size: 12px; color: var(--text-muted, #5b6370); min-height: 26px; flex: none; }
        .pane-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pane-close { width: 20px; height: 20px; border: none; border-radius: var(--radius-sm, 4px); background: transparent; color: var(--text-muted, #5b6370); cursor: pointer; font-size: 14px; line-height: 1; }
        .pane-close:hover { background: var(--surface, #fff); color: var(--danger, #b3372e); }
        /* 分屏：A/B 双面板，均显示源文件 */
        .editor.mode-split .main { flex-direction: row; }
        .editor.mode-split-v .main { flex-direction: column; }
        .editor.mode-split .pane { border-right: 1px solid var(--border, #d9dce2); }
        .editor.mode-split .pane:last-child { border-right: none; }
        .editor.mode-split-v .pane-b { border-top: 1px solid var(--border, #d9dce2); }
        .editor.mode-split .preview, .editor.mode-split-v .preview { display: none; }
        .editor:not(.mode-split):not(.mode-split-v) .pane-b { display: none; }
        .editor:not(.mode-split):not(.mode-split-v) [data-pane-head-a] { display: none !important; }
        .pane.drag-over { outline: 2px dashed var(--accent, #0e7c6b); outline-offset: -2px; background: var(--surface-2, #eceef1); }
        .editor.mode-preview .cm-wrap { display: none; }
        .editor.mode-source .preview { display: none; }
        .editor.mode-normal .preview { display: none; }
        .cm-wrap { flex: 1; min-height: 0; overflow: hidden; }
        .cm-wrap .placeholder { padding: var(--space-5, 24px); font-size: var(--font-size-sm, 13px); color: var(--text-muted, #5b6370); }
        /* 普通模式（所见即所得实时预览）样式 */
        .cm-line.cm-live-h1 { font-size: 20px; font-weight: 700; border-bottom: 1px solid var(--border, #d9dce2); line-height: 1.4; }
        .cm-line.cm-live-h2 { font-size: 17px; font-weight: 700; line-height: 1.4; }
        .cm-line.cm-live-h3 { font-size: 15px; font-weight: 600; line-height: 1.4; }
        .cm-line.cm-live-h4, .cm-line.cm-live-h5, .cm-line.cm-live-h6 { font-size: 14px; font-weight: 600; }
        .cm-line.cm-live-quote { color: var(--text-muted, #5b6370); border-left: 3px solid var(--border-strong, #b6bcc7); padding-left: var(--space-2, 8px); }
        .cm-line.cm-live-codeblock { background: var(--surface-2, #eceef1); font-family: var(--font-mono, monospace); }
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
        .preview { flex: 1; overflow-y: auto; padding: 12px 16px; font-size: var(--font-size-sm, 13px); line-height: 1.7; color: var(--text, #1a1d23); background: var(--surface, #fff); }
        .preview h1, .preview h2, .preview h3, .preview h4 { margin: 1em 0 .5em; line-height: 1.35; }
        .preview h1 { font-size: 20px; border-bottom: 1px solid var(--border, #d9dce2); padding-bottom: .3em; }
        .preview h2 { font-size: 17px; }
        .preview h3 { font-size: 15px; }
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
          </div>
          <div class="tree" data-tree></div>
        </aside>
        <div class="splitter" data-splitter title="拖动调整宽度"></div>
        <section class="editor mode-normal">
          <div class="editor-head">
            <span class="note-name" data-note-title>选择一篇笔记</span>
            <button type="button" class="icon-btn" data-act="toggle-side" title="折叠左侧" aria-label="折叠左侧">${ICON_PANEL_LEFT}</button>
            <div class="head-actions" data-head-actions>
              <button type="button" class="icon-btn" data-act="preview" title="预览" aria-label="预览">${ICON_EYE}</button>
              <button type="button" class="icon-btn" data-act="more" title="更多" aria-label="更多">${ICON_MORE}</button>
            </div>
          </div>
          <div class="editor-body">
            <div class="main">
              <div class="pane pane-a" data-pane-a>
                <div class="pane-head" data-pane-head-a hidden>
                  <span class="pane-title" data-pane-title-a></span>
                </div>
                <div class="cm-wrap" data-editor><div class="placeholder">选择或新建一篇笔记开始。</div></div>
                <div class="preview" data-preview></div>
              </div>
              <div class="pane pane-b" data-pane-b>
                <div class="pane-head" data-pane-head-b>
                  <span class="pane-title" data-pane-title-b>分屏</span>
                  <button type="button" class="pane-close" data-pane-close-b title="关闭分屏" aria-label="关闭分屏">×</button>
                </div>
                <div class="cm-wrap" data-editor-b>
                  <div class="placeholder">拖入笔记到此处打开。</div>
                </div>
              </div>
            </div>
            <div class="nav-pane hidden" data-nav>
              <div class="nav-toolbar">
                <div class="search-wrap">
                  <input class="side-search" type="text" placeholder="搜索…" spellcheck="false" aria-label="搜索" data-nav-search />
                  <button type="button" class="search-clear" data-nav-search-clear title="清除搜索" aria-label="清除搜索">
                    <svg viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
                  </button>
                </div>
              </div>
              <div class="nav-outline" data-nav-outline></div>
            </div>
          </div>
        </section>
        <div class="menu" data-sort-menu></div>
        <div class="menu" data-more-menu style="min-width:150px"></div>
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
    root.querySelector('[data-act="preview"]').addEventListener('click', () => this.togglePreview())
    root.querySelector('[data-act="more"]').addEventListener('click', (e) => this.toggleMoreMenu(e))
    root.querySelector('[data-nav-search]').addEventListener('input', (e) => {
      const v = e.target.value.trim().toLowerCase()
      this.navQuery = v
      this.shadowRoot.querySelector('[data-nav-search-clear]').classList.toggle('show', e.target.value.length > 0)
      this.renderPreview() // 只作用于导航面板：过滤/高亮大纲标题 + 高亮预览内容
    })
    root.querySelector('[data-nav-search-clear]').addEventListener('click', (e) => {
      e.stopPropagation()
      const input = this.shadowRoot.querySelector('[data-nav-search]')
      input.value = ''
      this.navQuery = ''
      this.shadowRoot.querySelector('[data-nav-search-clear]').classList.remove('show')
      this.renderPreview()
      input.focus()
    })
    root.querySelector('[data-nav-outline]').addEventListener('click', (e) => {
      const item = e.target.closest('[data-nav-idx]')
      if (!item) return
      const entry = this.outline[Number(item.dataset.navIdx)]
      if (entry?.el) entry.el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
    root.querySelector('[data-more-menu]').addEventListener('click', (e) => {
      const item = e.target.closest('[data-more-act]')
      if (!item) return
      const act = item.dataset.moreAct
      this.hideMoreMenu()
      this.moreAction(act)
    })
    root.querySelector('[data-splitter]').addEventListener('mousedown', (e) => this.startSplitDrag(e))
    root.querySelector('[data-pane-close-b]').addEventListener('click', () => {
      this.closePaneB()
      this.setViewMode('normal')
    })
    root.querySelector('[data-pane-b]').addEventListener('dragover', (e) => {
      e.preventDefault()
      root.querySelector('[data-pane-b]').classList.add('drag-over')
    })
    root.querySelector('[data-pane-b]').addEventListener('dragleave', (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) root.querySelector('[data-pane-b]').classList.remove('drag-over')
    })
    root.querySelector('[data-pane-b]').addEventListener('drop', (e) => {
      e.preventDefault()
      root.querySelector('[data-pane-b]').classList.remove('drag-over')
      const path = e.dataTransfer.getData('text/plain')
      if (path && this.isSplitMode(this.viewMode)) void this.openPaneB(path)
    })
    root.querySelector('[data-pane-a]').addEventListener('dragover', (e) => {
      e.preventDefault()
      root.querySelector('[data-pane-a]').classList.add('drag-over')
    })
    root.querySelector('[data-pane-a]').addEventListener('dragleave', (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) root.querySelector('[data-pane-a]').classList.remove('drag-over')
    })
    root.querySelector('[data-pane-a]').addEventListener('drop', (e) => {
      e.preventDefault()
      root.querySelector('[data-pane-a]').classList.remove('drag-over')
      const path = e.dataTransfer.getData('text/plain')
      if (!path) return
      const rect = e.currentTarget.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      if (!this.isSplitMode(this.viewMode)) {
        // 单面板：拖到右半 → 左右分屏(B)；下半 → 上下分屏(B)；左/上半 → 打开到 A
        if (x >= rect.width / 2) {
          this.setViewMode('split')
          void this.openPaneB(path)
        } else if (y >= rect.height / 2) {
          this.setViewMode('split-v')
          void this.openPaneB(path)
        } else {
          void this.openNote(path)
        }
      } else {
        void this.openNote(path) // 分屏中拖到 A → 打开到 A
      }
    })
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
      if (!e.target.closest('[data-more-menu]') && !e.target.closest('[data-act="more"]')) this.hideMoreMenu()
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
      this.tree.set(dir, entries)
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
    side.style.display = this.sideCollapsed ? 'none' : ''
    splitter.style.display = this.sideCollapsed ? 'none' : ''
    btn.innerHTML = this.sideCollapsed ? ICON_PANEL_RIGHT : ICON_PANEL_LEFT
    btn.title = this.sideCollapsed ? '展开左侧' : '折叠左侧'
    btn.setAttribute('aria-label', btn.title)
    if (!this.sideCollapsed) this.renderTree()
  }

  startSplitDrag(e) {
    e.preventDefault()
    const splitter = this.shadowRoot.querySelector('[data-splitter]')
    const side = this.shadowRoot.querySelector('.side')
    const appRect = this.shadowRoot.querySelector('.app').getBoundingClientRect()
    splitter.classList.add('dragging')
    document.body.style.userSelect = 'none'
    const onMove = (ev) => {
      const width = Math.min(Math.max(ev.clientX - appRect.left, 150), Math.round(appRect.width * 0.6))
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

  togglePreview() {
    this.setViewMode(this.viewMode === 'preview' ? 'normal' : 'preview')
  }

  setViewMode(mode) {
    // 退出分屏时关闭 B 面板
    if (this.isSplitMode(this.viewMode) && !this.isSplitMode(mode)) this.closePaneB()
    this.viewMode = mode
    const editor = this.shadowRoot.querySelector('.editor')
    editor.classList.remove('mode-normal', 'mode-source', 'mode-preview', 'mode-split', 'mode-split-v')
    editor.classList.add('mode-' + mode)
    // 普通模式 = 所见即所得实时预览；源文件/分屏 = 原文显示语法
    const live = mode === 'normal'
    if (this.editor && this.liveCompartment && live !== this.live) {
      this.live = live
      this.editor.dispatch({ effects: this.liveCompartment.reconfigure(live ? livePreviewExt() : []) })
    } else {
      this.live = live
    }
    const previewBtn = this.shadowRoot.querySelector('[data-act="preview"]')
    previewBtn.classList.toggle('on', mode === 'preview')
    if (mode === 'preview') this.renderPreview()
    if (this.isSplitMode(mode)) this.updatePaneB()
    this.renderMoreMenu()
    if (mode === 'normal' || mode === 'source') this.editor?.focus()
  }

  isSplitMode(mode) {
    return mode === 'split' || mode === 'split-v'
  }

  toggleMoreMenu(e) {
    const menu = this.shadowRoot.querySelector('[data-more-menu]')
    if (menu.classList.contains('show')) {
      this.hideMoreMenu()
      return
    }
    this.renderMoreMenu()
    const host = this.shadowRoot.querySelector('.app').getBoundingClientRect()
    const rect = e.currentTarget.getBoundingClientRect()
    menu.style.left = Math.max(0, rect.right - host.left - 160) + 'px'
    menu.style.top = rect.bottom - host.top + 4 + 'px'
    menu.classList.add('show')
  }

  renderMoreMenu() {
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
          `<div class="menu-item${this.moreActive(x.act) ? ' on' : ''}" data-more-act="${x.act}">${x.icon}<span>${x.label}</span></div>`,
      )
      .join('')
  }

  moreActive(act) {
    if (act === 'nav') return this.navOpen
    return this.viewMode === act
  }

  moreAction(act) {
    if (act === 'normal') return this.setViewMode('normal')
    if (act === 'preview') return this.setViewMode(this.viewMode === 'preview' ? 'normal' : 'preview')
    if (act === 'source') return this.setViewMode('source') // 源文件 = 显示原始 markdown 语法
    if (act === 'split') return this.setViewMode(this.viewMode === 'split' ? 'normal' : 'split')
    if (act === 'split-v') return this.setViewMode(this.viewMode === 'split-v' ? 'normal' : 'split-v')
    if (act === 'nav') return this.toggleNav()
  }

  hideMoreMenu() {
    this.shadowRoot.querySelector('[data-more-menu]').classList.remove('show')
  }

  toggleNav() {
    this.navOpen = !this.navOpen
    this.shadowRoot.querySelector('[data-nav]').classList.toggle('hidden', !this.navOpen)
    if (this.navOpen) this.renderPreview()
    this.renderMoreMenu()
  }

  renderPreview() {
    const preview = this.shadowRoot.querySelector('[data-preview]')
    if (!preview) return
    const content = this.editor?.state.doc.toString() ?? ''
    const raw = content ? marked.parse(content) : ''
    const safe = content ? DOMPurify.sanitize(raw) : ''
    preview.innerHTML = safe
    this.applyNavHighlight()
    this.buildOutline()
  }

  applyNavHighlight() {
    if (!this.navQuery) return
    const preview = this.shadowRoot.querySelector('[data-preview]')
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT)
    const targets = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.parentElement?.closest('pre, code, script, style')) continue
      targets.push(node)
    }
    for (const node of targets) {
      const text = node.textContent
      const lower = text.toLowerCase()
      let idx = lower.indexOf(this.navQuery)
      if (idx === -1) continue
      const frag = document.createDocumentFragment()
      let i = 0
      while (idx !== -1) {
        if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)))
        const mark = document.createElement('mark')
        mark.className = 'nav-hl'
        mark.textContent = text.slice(idx, idx + this.navQuery.length)
        frag.appendChild(mark)
        i = idx + this.navQuery.length
        idx = lower.indexOf(this.navQuery, i)
      }
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)))
      node.parentNode.replaceChild(frag, node)
    }
  }

  buildOutline() {
    const preview = this.shadowRoot.querySelector('[data-preview]')
    this.outline = [...preview.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((el) => ({
      el,
      level: Number(el.tagName[1]),
      text: el.textContent || '',
    }))
    const box = this.shadowRoot.querySelector('[data-nav-outline]')
    if (!this.outline.length) {
      box.innerHTML = '<div class="nav-empty">暂无标题大纲。</div>'
      return
    }
    const q = this.navQuery
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
    const items = this.outline.map((o, i) => ({ o, i })).filter(({ o }) => !q || o.text.toLowerCase().includes(q))
    if (!items.length) {
      box.innerHTML = '<div class="nav-empty">没有匹配的标题。</div>'
      return
    }
    box.innerHTML = items
      .map(
        ({ o, i }) =>
          `<div class="nav-item" data-nav-idx="${i}" style="padding-left:${(o.level - 1) * 12 + 8}px">${hl(o.text)}</div>`,
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

  // ---------- 打开/编辑 ----------
  async openNote(path) {
    if (this.current === path) {
      this.editor?.focus()
      return
    }
    await this.saveCurrent()
    try {
      const content = await window.api.pluginFiles.read(PLUGIN_ID, path)
      this.current = path
      this.selectedItem = path
      this.ensureEditor(content)
      const short = path.replace(/\.md$/, '').split('/').pop()
      this.shadowRoot.querySelector('[data-note-title]').textContent = short
      this.shadowRoot.querySelector('[data-pane-title-a]').textContent = short
      this.shadowRoot.querySelector('[data-head-actions]').classList.add('show')
      this.renderTree()
      this.renderPreview()
      this.editor?.focus()
    } catch (err) {
      console.error('[notes] 打开失败', err)
    }
  }

  ensureEditor(doc) {
    const host = this.shadowRoot.querySelector('[data-editor]')
    host.innerHTML = ''
    const content = typeof doc === 'string' ? doc : ''
    this.liveCompartment = new Compartment()
    this.live = this.viewMode === 'normal'
    this.editor = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          markdown({ base: markdownLanguage }), // GFM：表格/任务列表/删除线/自动链接/上下标等
          editorTheme,
          this.liveCompartment.of(this.live ? livePreviewExt() : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              this.scheduleSave()
              this.schedulePreview()
            }
          }),
        ],
      }),
      parent: host,
    })
  }

  scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.saveCurrent(), 600)
  }

  schedulePreview() {
    clearTimeout(this.previewTimer)
    this.previewTimer = setTimeout(() => {
      if (this.viewMode !== 'source') this.renderPreview()
    }, 300)
  }

  async saveCurrent() {
    if (!this.current || !this.editor) return
    const content = this.editor.state.doc.toString()
    try {
      await window.api.pluginFiles.write(PLUGIN_ID, this.current, content)
    } catch (err) {
      console.error('[notes] 保存失败', err)
    }
  }

  // ---------- 分屏 B 面板（源码视图，可拖入笔记 / 关闭） ----------
  updatePaneB() {
    if (!this.paneBPath) {
      this.shadowRoot.querySelector('[data-pane-title-b]').textContent = '分屏'
      const host = this.shadowRoot.querySelector('[data-editor-b]')
      if (!this.editorB) host.innerHTML = '<div class="placeholder">拖入笔记到此处打开。</div>'
      return
    }
    const short = this.paneBPath.split('/').pop().replace(/\.md$/, '')
    this.shadowRoot.querySelector('[data-pane-title-b]').textContent = short
  }

  async openPaneB(path) {
    try {
      const content = await window.api.pluginFiles.read(PLUGIN_ID, path)
      this.paneBPath = path
      const host = this.shadowRoot.querySelector('[data-editor-b]')
      if (this.editorB) this.editorB.destroy()
      host.innerHTML = ''
      this.editorB = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            markdown({ base: markdownLanguage }),
            editorTheme,
            EditorView.updateListener.of((u) => {
              if (u.docChanged) this.schedulePaneBSave()
            }),
          ],
        }),
        parent: host,
      })
      this.updatePaneB()
      this.editorB.focus()
    } catch (err) {
      console.error('[notes] 分屏打开失败', path, err)
    }
  }

  closePaneB() {
    clearTimeout(this.paneBSaveTimer)
    if (this.paneBPath && this.editorB) {
      const content = this.editorB.state.doc.toString()
      window.api.pluginFiles.write(PLUGIN_ID, this.paneBPath, content).catch(() => {})
    }
    this.editorB?.destroy()
    this.editorB = null
    this.paneBPath = null
    const host = this.shadowRoot.querySelector('[data-editor-b]')
    if (host) host.innerHTML = '<div class="placeholder">拖入笔记到此处打开。</div>'
    this.updatePaneB()
  }

  schedulePaneBSave() {
    clearTimeout(this.paneBSaveTimer)
    this.paneBSaveTimer = setTimeout(() => {
      if (this.paneBPath && this.editorB) {
        window.api.pluginFiles.write(PLUGIN_ID, this.paneBPath, this.editorB.state.doc.toString()).catch((err) => {
          console.error('[notes] 分屏保存失败', err)
        })
      }
    }, 600)
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
      await this.saveCurrent() // 先落盘未保存内容，避免删除后防抖保存把文件写回
      try {
        await window.api.pluginFiles.remove(PLUGIN_ID, path)
        if (this.paneBPath && (this.paneBPath === path || this.paneBPath.startsWith(path + '/'))) this.closePaneB()
        if (this.current && (this.current === path || this.current.startsWith(path + '/'))) this.resetEditor()
        // 清理展开状态残留（删除的文件夹及其后代）
        for (const p of [...this.expanded]) if (p === path || p.startsWith(path + '/')) this.expanded.delete(p)
        if (this.selectedItem === path || (this.selectedItem && this.selectedItem.startsWith(path + '/'))) this.selectedItem = ROOT
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT
        await this.loadDir(parent)
      } catch (err) {
        console.error('[notes] 删除失败', err)
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
      await this.saveCurrent()
      const folders = await this.collectAllFolders()
      const display = path.split('/').pop().replace(/\.md$/, '')
      const target = await this.openFolderDialog(`移动「${display}」到`, folders, path)
      if (target == null) return
      const newPath = (target ? target + '/' : '') + path.split('/').pop()
      if (newPath === path) return
      try {
        await window.api.pluginFiles.move(PLUGIN_ID, path, newPath)
        if (this.paneBPath && (this.paneBPath === path || this.paneBPath.startsWith(path + '/'))) this.closePaneB()
        if (this.current && (this.current === path || this.current.startsWith(path + '/'))) {
          this.current = newPath + this.current.slice(path.length)
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
    await this.saveCurrent()
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
      if (this.paneBPath && (this.paneBPath === path || this.paneBPath.startsWith(path + '/'))) this.closePaneB()
      if (this.current && (this.current === path || this.current.startsWith(path + '/'))) {
        this.current = newPath + this.current.slice(path.length)
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
    this.closePaneB()
    this.current = null
    this.editor?.destroy()
    this.editor = null
    this.viewMode = 'normal'
    this.live = true
    this.liveCompartment = null
    this.navOpen = false
    this.navQuery = ''
    this.filter = ''
    clearTimeout(this.previewTimer)
    this.shadowRoot.querySelector('[data-editor]').innerHTML = '<div class="placeholder">选择或新建一篇笔记开始。</div>'
    this.shadowRoot.querySelector('[data-note-title]').textContent = '选择一篇笔记'
    this.shadowRoot.querySelector('[data-pane-title-a]').textContent = ''
    this.shadowRoot.querySelector('[data-head-actions]').classList.remove('show')
    this.shadowRoot.querySelector('[data-preview]').innerHTML = ''
    this.shadowRoot.querySelector('[data-nav]').classList.add('hidden')
    this.shadowRoot.querySelector('[data-nav-search]').value = ''
    this.shadowRoot.querySelector('[data-nav-search-clear]').classList.remove('show')
    this.shadowRoot.querySelector('[data-nav-outline]').innerHTML = '<div class="nav-empty">暂无标题大纲。</div>'
    const editor = this.shadowRoot.querySelector('.editor')
    editor.classList.remove('mode-normal', 'mode-source', 'mode-preview', 'mode-split', 'mode-split-v')
    editor.classList.add('mode-normal')
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

customElements.define('app-plugin-notes', NotesApp)
