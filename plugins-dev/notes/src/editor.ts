// CodeMirror 编辑器公共配置（主题 + 跨面板同步标记）
import { Annotation } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** 分屏同文件多份时的内容同步标记：带此 annotation 的改动来自其他面板，不再转发/落盘 */
export const Sync = Annotation.define<boolean>()

export const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: '14px' },
    '.cm-scroller': { lineHeight: '1.7', scrollBehavior: 'smooth' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '0', maxWidth: '800px', margin: '0 auto', fontFamily: 'var(--font-ui)', fontSize: '14px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-activeLine': { backgroundColor: 'var(--surface-2)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-2)' },
    '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
    '.cm-lineNumbers .cm-gutterElement': { color: 'var(--text-muted)' },
    // 选区颜色由 styles.ts 以 .cm-editor + !important 覆盖 drawSelection 默认（base theme），
    // 这里不放 &light/&dark 键——EditorView.theme() 不支持该选择器，会抛 RangeError 导致插件加载失败
    '.cm-matchingBracket': { backgroundColor: 'var(--surface-2)', outline: '1px solid var(--border-strong)' },
    '.cm-placeholder': { color: 'var(--text-muted)', fontStyle: 'italic' },
  },
  { dark: false },
)
