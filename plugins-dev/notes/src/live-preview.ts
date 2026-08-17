// 普通模式（所见即所得实时预览）：用 decoration 隐藏 markdown 语法标记、样式化标题/强调/链接等
// 与 CodeMirror 强耦合的独立模块：widget 类 + livePreviewExt（ViewPlugin）
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { Range } from '@codemirror/state'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'

// 表格列分隔 `|` → 视觉分隔线 widget（保持单元格文字可编辑）
class TableSepWidget extends WidgetType {
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'cm-live-tbl-sep'
    return s
  }
  eq(o: WidgetType): boolean {
    return o instanceof TableSepWidget
  }
  ignoreEvent(): boolean {
    return false
  }
}

// 任务列表 `[ ]` / `[x]` → 可点击复选框 widget（点击切换完成态，记录原文范围）
class TaskBoxWidget extends WidgetType {
  constructor(
    private readonly done: boolean,
    private readonly from: number,
    private readonly to: number,
  ) {
    super()
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'cm-task-box' + (this.done ? ' done' : '')
    s.dataset.from = String(this.from)
    s.dataset.to = String(this.to)
    return s
  }
  eq(o: WidgetType): boolean {
    return o instanceof TaskBoxWidget && o.done === this.done && o.from === this.from && o.to === this.to
  }
  ignoreEvent(): boolean {
    return true
  }
}

class LivePreviewPlugin {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.build(view)
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view)
  }

  build(view: EditorView): DecorationSet {
    const state = view.state
    const tree = syntaxTree(state)
    const decos: Array<Range<Decoration>> = [] // mark/replace/line 混用，统一为 Range<Decoration>
    const lineClasses = new Map<number, string>() // lineNo -> cls
    const addMark = (from: number, to: number, cls: string) => decos.push(Decoration.mark({ class: cls }).range(from, to))
    const hideRange = (from: number, to: number) => decos.push(Decoration.replace({}).range(from, to))
    // 隐藏标记本身 + 其后空白（`# `、`- `、`> `、`1. `），让内容从行首开始
    const hideMarker = (markFrom: number, markTo: number, limit: number) => {
      const line = state.doc.lineAt(markTo)
      let end = markTo
      while (end < limit && end <= line.to && (state.sliceDoc(end, end + 1) === ' ' || state.sliceDoc(end, end + 1) === '\t')) end++
      hideRange(markFrom, end)
    }
    const lineCls = (lineNo: number, cls: string) => {
      lineClasses.set(lineNo, ((lineClasses.get(lineNo) || '') + ' ' + cls).trim())
    }
    tree.iterate({
      enter: (n: SyntaxNodeRef) => {
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
          const marks: Array<[number, number]> = []
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
          const marks: Array<[number, number]> = []
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
          const pieces: SyntaxNode[] = []
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
          const marks: Array<[number, number]> = []
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
          const walkTbl = (node: SyntaxNode): void => {
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
          const pieces: SyntaxNode[] = []
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
}

/** 普通模式实时预览扩展（每次调用创建新实例；配合 Compartment 切换开关）。
 * 注意：不要给返回值加 `ReturnType<typeof ViewPlugin.fromClass>` 注解——那会把泛型参数解析成
 * `ViewPlugin<PluginValue, unknown>`（extension 为 null，不兼容 Extension）；让 TS 从类上推断 Arg=undefined。 */
export const livePreviewExt = () =>
  ViewPlugin.fromClass(LivePreviewPlugin, { decorations: (v) => v.decorations })
