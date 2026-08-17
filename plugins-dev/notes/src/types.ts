// 数据模型与共享类型定义（单一事实来源：types.ts）
import type { Compartment } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** 插件文件存储契约（docs/插件契约.md §6）的目录条目 */
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  mtimeMs?: number
  createdMs?: number
}

/** 面板显示模式 */
export type PaneMode = 'normal' | 'source' | 'preview'

/** 分屏方向 */
export type SplitDir = 'row' | 'column'

/** 分屏树叶子：指向一张卡片 */
export interface SplitLeaf {
  type: 'leaf'
  cardId: string
}

/** 分屏树内部节点 */
export interface SplitNode {
  type: 'split'
  dir: SplitDir
  children: [SplitTree, SplitTree]
  /** 拖动分割线后记住首面板大小（重建 DOM 时恢复） */
  firstSize?: number
}

/** 分屏树（叶子或内部节点） */
export type SplitTree = SplitLeaf | SplitNode

/** 分屏容器 DOM 元素：携带回写分割大小的节点引用 */
export interface SplitElement extends HTMLDivElement {
  _splitNode?: SplitNode
}

/** 打开的面板（标签）记录 */
export interface PaneRecord {
  id: string
  cardId: string | null
  path: string | null
  mode: PaneMode
  editor: EditorView | null
  saveTimer: ReturnType<typeof setTimeout> | null
  liveCompartment: Compartment | null
  live: boolean
}

/** 卡片（分屏单元）：自带标签栏 + 路径栏 + 编辑器 + 独立导航（搜索+大纲） */
export interface CardRecord {
  id: string
  paneIds: string[]
  activePaneId: string | null
  navOpen: boolean
  navQuery: string
  outline: OutlineEntry[]
}

/** 大纲条目（渲染预览里的标题元素引用） */
export interface OutlineEntry {
  el: HTMLElement
  level: number
  text: string
}

export type SortKey = 'name' | 'created' | 'modified'

export interface SortOption {
  key: SortKey
  dir: 1 | -1
  label: string
}

export type DialogMode = 'input' | 'folder' | 'confirm'

/** 弹层状态（输入/选文件夹/确认） */
export interface DialogState {
  title: string
  mode: DialogMode
  /** 方法语法（非属性语法）：strictFunctionTypes 下方法参数双变，可兼容各 Promise resolve 的窄参数类型 */
  resolve(value: string | boolean | null): void
  /** confirm 弹层的提示文本 */
  message?: string
  /** folder 弹层的选中文件夹 */
  folderValue?: string
}

/** 右键菜单上下文 */
export interface ContextState {
  path: string
  kind: string
}

/** 更多菜单动作 */
export type MoreAction = 'normal' | 'source' | 'preview' | 'split' | 'split-v' | 'nav'

/** 右键菜单动作 */
export type CtxAction = 'copy' | 'move' | 'rename' | 'delete'
