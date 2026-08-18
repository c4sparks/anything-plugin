// NotesApp 主类：笔记知识库插件（个人知识库）——左右布局 + 文件夹/文件树 + 排序 + 展开收起 + 右键菜单
// 多开面板模型：panes = 所有打开的笔记（标签）；分屏按「卡片」分组，每张卡片自带独立标签栏。
// 数据：window.api.pluginFiles（契约 docs/插件契约.md §6），存 userData/plugin-data/notes/files/。
import { Compartment, EditorState, type Transaction } from '@codemirror/state'
import { placeholder } from '@codemirror/view'
import { EditorView, basicSetup } from 'codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import DOMPurify from 'dompurify'

import { editorTheme, Sync } from './editor'
import { livePreviewExt } from './live-preview'
import { hydrateMermaid, renderMarkdown } from './markdown'
import { NoteIndex } from './search'
import { SHELL_CSS } from './styles'
import { clearTimer, escapeAttr, escapeHtml, highlightMatch, mustQuery, normalizePath, removeLeaf, targetClosest } from './util'
import {
  ICON_COLLAPSE,
  ICON_CTX_COPY,
  ICON_CTX_DELETE,
  ICON_CTX_MOVE,
  ICON_CTX_RENAME,
  ICON_DOC_SM,
  ICON_EDIT,
  ICON_EXPAND,
  ICON_EYE,
  ICON_FILE,
  ICON_FOLDER,
  ICON_FOLDER_SM,
  ICON_MORE,
  ICON_NAV,
  ICON_PANEL_LEFT,
  ICON_PANEL_RIGHT,
  ICON_PLUS,
  ICON_SORT,
  ICON_SOURCE,
  ICON_SPLIT_H,
  ICON_SPLIT_V,
} from './icons'
import type {
  CardRecord,
  ContextState,
  CtxAction,
  DialogState,
  FileEntry,
  MoreAction,
  PaneMode,
  PaneRecord,
  SortKey,
  SortOption,
  SplitDir,
  SplitElement,
  SplitTree,
} from './types'

const PLUGIN_ID = 'notes'
const ROOT = ''
/** 侧栏折叠为窄条时的宽度（= 折叠/展开按钮宽度） */
const SIDE_COLLAPSED = 36

/** 文件树虚拟化：固定行高与视口缓冲（须与 styles.ts `.t-row` 高度一致） */
const ROW_H = 26
const OVERSAN = 10

/** 文件树虚拟化扁平行（rebuildFlatRows 生成，renderTreeWindow 只渲染可见窗口） */
interface FlatRow {
  path: string
  kind: 'folder' | 'file'
  depth: number
  name: string
  expanded: boolean
  sel: boolean
  cur: boolean
}

const SORT_OPTIONS: SortOption[] = [
  { key: 'name', dir: 1, label: '文件名 升序' },
  { key: 'name', dir: -1, label: '文件名 降序' },
  { key: 'created', dir: 1, label: '创建时间 升序' },
  { key: 'created', dir: -1, label: '创建时间 降序' },
  { key: 'modified', dir: 1, label: '修改时间 升序' },
  { key: 'modified', dir: -1, label: '修改时间 降序' },
]

export class NotesApp extends HTMLElement {
  private tree = new Map<string, FileEntry[]>() // 目录 key(''=根) -> entries[]
  private expanded = new Set<string>()
  private selectedFolder: string = ROOT // 新文件/夹落点
  private selectedItem: string | null = null // 树中选中项（文件/夹 path）
  /** 树多选：Shift 连选 / Ctrl(Cmd) 切换 的附加选中集（不含 selectedItem 主选中） */
  private multiSel = new Set<string>()
  /** Shift 连选锚点行 path */
  private selAnchor: string | null = null
  private panes = new Map<string, PaneRecord>() // paneId -> 面板（标签）记录
  private cards = new Map<string, CardRecord>() // cardId -> 卡片（分屏单元）记录
  private splitRoot: SplitTree | null = null // null=单卡片 | {type:'split',dir,children:[leaf,leaf]}（叶子为 cardId）
  private activePaneId: string | null = null // 当前激活标签
  private activeCardId: string | null = null // 当前聚焦卡片
  private lastActivePaneId: string | null = null
  private nextPaneId = 1
  private nextCardId = 1
  private filter = ''
  private sortKey: SortKey = 'name'
  private sortDir: 1 | -1 = 1
  private sideCollapsed = false
  private sideWidth = 260
  private morePaneId: string | null = null // 更多菜单当前作用的面板 id
  private previewTimer: ReturnType<typeof setTimeout> | null = null
  private context: ContextState | null = null
  /** 编辑区右键菜单作用的面板 id */
  private editMenuPaneId: string | null = null
  private dialog: DialogState | null = null // {title, mode:'input'|'folder'|'confirm', resolve, message?}
  // 文件树虚拟化：扁平行模型 + 滚动/渲染 rAF + 目录排序缓存
  private flatRows: FlatRow[] = []
  private sortCache = new Map<string, FileEntry[]>()
  private treeScrollRaf = 0
  private treeRenderRaf = 0
  // 全文搜索（MiniSearch 内存索引 + 搜索 UI 状态）
  private search = new NoteIndex()
  private searchTimer: ReturnType<typeof setTimeout> | null = null
  private searchQuery = ''

  get activePane(): PaneRecord | null {
    return this.activePaneId ? (this.panes.get(this.activePaneId) ?? null) : null
  }

  /** 激活面板的笔记路径（向后兼容旧 `this.current` 读法；ESM strict 下不可赋值，所有赋值点已改写） */
  get current(): string | null {
    return this.activePane?.path ?? null
  }

  get activeCard(): CardRecord | null {
    return this.activeCardId ? (this.cards.get(this.activeCardId) ?? null) : null
  }

  /** shadowRoot 访问器：connectedCallback 后必存在 */
  private get sr(): ShadowRoot {
    const root = this.shadowRoot
    if (!root) throw new Error('[notes] shadowRoot 未挂载')
    return root
  }

  connectedCallback(): void {
    this.attachShadow({ mode: 'open' })
    this.renderShell()
    this.bind()
    this.updateHead() // 初始无面板：显示全局占位（含重建）
    void this.loadDir(ROOT)
    void this.buildFullIndex() // 后台分批建全文索引（不阻塞 UI）
  }

  disconnectedCallback(): void {
    clearTimer(this.previewTimer)
    clearTimer(this.searchTimer)
    for (const rec of this.panes.values()) {
      clearTimer(rec.saveTimer)
      // 脏检查：未修改不写盘（fire-and-forget）
      if (rec.path && rec.editor && rec.lastSavedText !== rec.editor.state.doc.toString()) {
        window.api.pluginFiles.write(PLUGIN_ID, rec.path, rec.editor.state.doc.toString()).catch(() => {})
      }
      rec.editor?.destroy()
    }
    this.panes.clear()
  }

  // ---------- 渲染 ----------
  renderShell(): void {
    this.sr.innerHTML = `
      <style>${SHELL_CSS}</style>
      <div class="app">
        <aside class="side">
          <div class="toolbar">
            <button class="icon-btn" data-act="new-file" title="新增文件" aria-label="新增文件">${ICON_FILE}</button>
            <button class="icon-btn" data-act="new-folder" title="新增文件夹" aria-label="新增文件夹">${ICON_FOLDER}</button>
            <button class="icon-btn" data-act="sort" title="排序" aria-label="排序">${ICON_SORT}</button>
            <button class="icon-btn" data-act="expand" title="展开/收起" aria-label="展开收起">${ICON_EXPAND}</button>
            <button type="button" class="icon-btn" data-act="toggle-side" title="折叠左侧" aria-label="折叠左侧">${ICON_PANEL_LEFT}</button>
          </div>
          <div class="search-wrap">
            <input class="side-search" data-side-search placeholder="搜索笔记…" spellcheck="false" />
            <button type="button" class="search-clear" data-search-clear title="清除搜索" aria-label="清除搜索">×</button>
          </div>
          <div class="tree" data-tree></div>
          <div class="search-results" data-search-results hidden></div>
          <div class="search-status" data-search-status hidden></div>
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
        <div class="edit-menu" data-edit-menu></div>
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

  bind(): void {
    const root = this.sr
    mustQuery(root, '[data-act="new-file"]').addEventListener('click', () => this.newEntry('file'))
    mustQuery(root, '[data-act="new-folder"]').addEventListener('click', () => this.newEntry('folder'))
    mustQuery(root, '[data-act="sort"]').addEventListener('click', (e) => this.toggleSortMenu(e))
    mustQuery(root, '[data-act="expand"]').addEventListener('click', () => this.toggleExpandAll())
    mustQuery(root, '[data-act="toggle-side"]').addEventListener('click', () => this.toggleSide())
    mustQuery(root, '[data-more-menu]').addEventListener('click', (e) => {
      const item = targetClosest<HTMLElement>(e, '[data-more-act]')
      if (!item) return
      const act = item.dataset.moreAct as MoreAction
      this.hideMoreMenu()
      this.moreAction(act, this.morePaneId)
    })
    mustQuery(root, '[data-splitter]').addEventListener('mousedown', (e) => this.startSplitDrag(e))
    const splitRoot = mustQuery<HTMLElement>(root, '[data-split-root]')
    // 卡片内事件委托：标签切换/关闭、新建、更多、点击聚焦、拖拽（标签栏=多开，内容=插链接）、导航（搜索/清除/大纲）、预览链接
    splitRoot.addEventListener('click', (e) => {
      // 目标可能是文本节点（预览渲染文本/编辑器文本）：统一取元素再判定
      const t = e.target
      const el = t instanceof Element ? t : t instanceof Text ? t.parentElement : null
      // 预览区链接：内部笔记路径 → 打开笔记；https 等外部 → 系统浏览器（宿主 windowOpenHandler）；#锚点 → 滚动到标题
      const plink = el ? el.closest<HTMLAnchorElement>('.preview a[href]') : null
      if (plink) {
        e.preventDefault()
        e.stopPropagation()
        const href = plink.getAttribute('href') ?? ''
        if (href.startsWith('#')) {
          this.sr.getElementById(href.slice(1))?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          return
        }
        this.handleLinkClick(href)
        return
      }
      const card = targetClosest<HTMLElement>(e, '[data-card-id]')
      if (!card) return
      const cardId = card.dataset.cardId
      const clearBtn = targetClosest<HTMLElement>(e, '.card-nav-clear')
      if (clearBtn) {
        e.stopPropagation()
        const c = cardId ? this.cards.get(cardId) : undefined
        if (c) {
          c.navQuery = ''
          clearBtn.classList.remove('show')
          const input = cardId ? this.sr.querySelector<HTMLInputElement>(`[data-card-nav-search="${cardId}"]`) : null
          if (input) input.value = ''
          this.refreshNav(c) // 统一入口：还原高亮 + 重建大纲（含门）
        }
        return
      }
      const navIdxEl = targetClosest<HTMLElement>(e, '[data-card-nav-idx]')
      if (navIdxEl) {
        const c = cardId ? this.cards.get(cardId) : undefined
        const entry = c?.outline[Number(navIdxEl.dataset.cardNavIdx)]
        if (entry?.el) entry.el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }
      const closeBtn = targetClosest<HTMLElement>(e, '.ctab-close')
      if (closeBtn) {
        e.stopPropagation()
        void this.closePane(closeBtn.dataset.cardTabClose)
        return
      }
      const newBtn = targetClosest<HTMLElement>(e, '.ctab-new')
      if (newBtn) {
        void this.newNoteFromPane(cardId ? this.cards.get(cardId)?.activePaneId : undefined)
        return
      }
      const tab = targetClosest<HTMLElement>(e, '[data-card-tab]')
      if (tab) {
        this.activatePane(tab.dataset.cardTab) // 点标签只切换，不关闭
        return
      }
      const moreBtn = targetClosest<HTMLElement>(e, '.card-more')
      if (moreBtn) {
        const paneId = cardId ? this.cards.get(cardId)?.activePaneId : undefined
        if (paneId) {
          this.activeCardId = cardId ?? null // 聚焦该卡片，分屏/模式作用到它
          this.morePaneId = paneId
          this.toggleMoreMenu(moreBtn, paneId)
        }
        return
      }
      const paneId = cardId ? this.cards.get(cardId)?.activePaneId : undefined
      if (paneId) this.activatePane(paneId) // 点卡片其它区域 → 聚焦该卡片激活标签
    })
    // 卡片导航搜索输入：120ms 防抖 → refreshNav（门控：内容与查询都未变则跳过重建）
    splitRoot.addEventListener('input', (e) => {
      const search = targetClosest<HTMLInputElement>(e, '[data-card-nav-search]')
      if (!search) return
      const c = search.dataset.cardNavSearch ? this.cards.get(search.dataset.cardNavSearch) : undefined
      if (!c) return
      c.navQuery = search.value.trim().toLowerCase()
      // 有输入才显示清除按钮（叠于输入框内右缘）
      const clear = this.sr.querySelector<HTMLElement>(`[data-card-id="${c.id}"] .card-nav-clear`)
      clear?.classList.toggle('show', !!c.navQuery)
      clearTimer(c.navTimer)
      c.navTimer = setTimeout(() => this.refreshNav(c), 120)
    })
    splitRoot.addEventListener('focusin', (e) => {
      const card = targetClosest<HTMLElement>(e, '[data-card-id]')
      if (!card) return
      const paneId = card.dataset.cardId ? this.cards.get(card.dataset.cardId)?.activePaneId : undefined
      if (paneId) this.activatePane(paneId)
    })
    splitRoot.addEventListener('mousedown', (e) => {
      const divider = targetClosest<HTMLElement>(e, '.split-divider')
      if (!divider) return
      e.preventDefault()
      this.startDividerDrag(e, divider)
    })
    // 编辑区右键菜单：作用于该卡片激活标签的编辑器（新增链接/文本格式/段落设置/插入/剪贴板）
    // 捕获阶段 + 兼容文本节点目标：预览渲染的纯文本/编辑器内文本节点右键时 e.target 是 Text，
    // 若按 Element 判断会漏判导致菜单不出现（普通/预览/源文件三种模式均须可用）
    splitRoot.addEventListener(
      'contextmenu',
      (e) => {
        const t = e.target
        const targetEl = t instanceof Element ? t : t instanceof Text ? t.parentElement : null
        if (!targetEl) return
        if (!targetEl.closest('.card-editor')) return // 仅编辑器列（含预览）
        const card = targetEl.closest<HTMLElement>('[data-card-id]')
        if (!card?.dataset.cardId) return
        const paneId = this.cards.get(card.dataset.cardId)?.activePaneId
        const rec = paneId ? this.panes.get(paneId) : undefined
        if (!paneId || !rec?.editor) return
        // 预览模式：编辑器隐藏，不需要编辑右键菜单（不拦截，走浏览器原生菜单，便于复制预览文本）
        if (rec.mode === 'preview') return
        e.preventDefault()
        e.stopPropagation()
        // 右键时若无可编辑选区，自动选中光标下的词（便于直接复制/剪切；编辑器可见时才定位）
        const view = rec.editor
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
        if (pos != null && view.state.selection.main.empty) {
          const line = view.state.doc.lineAt(pos)
          const text = line.text
          const rel = Math.max(0, Math.min(pos - line.from, text.length))
          const isWord = (c: string) => /[\w\u4e00-\u9fff]/.test(c)
          let s = rel
          let t = rel
          while (s > 0 && isWord(text[s - 1])) s--
          while (t < text.length && isWord(text[t])) t++
          if (s < t) view.dispatch({ selection: { anchor: line.from + s, head: line.from + t } })
        }
        this.showEditMenu(e, paneId)
      },
      { capture: true },
    )
    // capture：抢在 CodeMirror 自身的 drop/dragover 之前处理，避免编辑器把路径当文本插入
    splitRoot.addEventListener(
      'dragover',
      (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        const card = targetClosest<HTMLElement>(e, '[data-card-id]')
        const hint = this.sr.querySelector<HTMLElement>('[data-drag-hint]')
        if (card && hint) {
          hint.textContent = targetClosest<HTMLElement>(e, '.card-tabs, .card-page') ? '打开为新标签' : '插入链接'
          hint.style.left = e.clientX + 10 + 'px'
          hint.style.top = e.clientY + 16 + 'px'
          hint.classList.add('show')
        }
      },
      { capture: true },
    )
    splitRoot.addEventListener('dragleave', (e) => {
      const card = targetClosest<HTMLElement>(e, '[data-card-id]')
      if (card && !card.contains(e.relatedTarget as Node | null)) {
        const hint = this.sr.querySelector<HTMLElement>('[data-drag-hint]')
        if (hint) hint.classList.remove('show')
      }
    })
    splitRoot.addEventListener(
      'drop',
      (e) => {
        e.preventDefault()
        e.stopPropagation()
        const dt = e.dataTransfer
        const path = dt ? dt.getData('text/plain') : ''
        const hint = this.sr.querySelector<HTMLElement>('[data-drag-hint]')
        if (hint) hint.classList.remove('show')
        if (!path) return
        const card = targetClosest<HTMLElement>(e, '[data-card-id]')
        if (!card) {
          void this.openNote(path) // 空容器 → 打开到激活卡片
          return
        }
        const cardId = card.dataset.cardId
        const paneId = cardId ? this.cards.get(cardId)?.activePaneId : undefined
        if (targetClosest<HTMLElement>(e, '.card-tabs, .card-page')) {
          // 拖到卡片标签栏/路径栏 → 在该卡片多开（插到激活标签后面）
          void this.openAsTab(path, paneId ?? null)
          return
        }
        // 内容区 → 按落点插入链接（空标签退化为打开）
        if (paneId) void this.insertLinkAt(paneId, path, e.clientX, e.clientY)
      },
      { capture: true },
    )
    mustQuery(root, '[data-tree]').addEventListener('dragstart', (e) => {
      const row = targetClosest<HTMLElement>(e, '[data-path]')
      if (!row || row.dataset.kind !== 'file') return
      const dt = e.dataTransfer
      if (!dt) return
      dt.setData('text/plain', row.dataset.path ?? '')
      dt.effectAllowed = 'copy'
    })
    mustQuery(root, '[data-tree]').addEventListener('click', (e) => {
      const row = targetClosest<HTMLElement>(e, '[data-path]')
      if (!row) {
        // 点击文件树空白处 = 回到根，并清空多选
        this.multiSel.clear()
        this.selAnchor = null
        this.selectFolder(ROOT)
        return
      }
      const path = row.dataset.path
      if (!path) return
      const kind = row.dataset.kind
      if (e.shiftKey) {
        // Shift+点击：从锚点行到当前行连续多选（文件/文件夹均可），不触发打开/展开
        e.preventDefault()
        this.rangeSelect(path)
        return
      }
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+点击：切换该行加入/移出多选，不触发打开/展开
        e.preventDefault()
        this.toggleSelect(path)
        return
      }
      // 普通点击：清空多选，保持原有行为（文件打开 / 文件夹展开收起）
      this.multiSel.clear()
      this.selAnchor = null
      if (kind === 'folder') {
        if (path) this.selectFolder(path)
      } else if (path) {
        void this.openNote(path)
      }
    })
    mustQuery(root, '[data-tree]').addEventListener('contextmenu', (e) => {
      const row = targetClosest<HTMLElement>(e, '[data-path]')
      if (!row || row.dataset.kind === 'root') return
      e.preventDefault()
      const path = row.dataset.path
      if (!path) return
      const kind = row.dataset.kind ?? 'file'
      // 右键落在当前选中集内 → 对整个选中集操作；否则重置为单行选中
      const paths = this.effectiveSelection()
      if (paths.includes(path)) {
        this.showContext(e, path, kind, paths)
      } else {
        this.multiSel.clear()
        this.selAnchor = null
        this.selectedItem = path
        this.renderTreeWindow()
        this.showContext(e, path, kind, [path])
      }
    })
    // 文件树虚拟化：滚动只重绘可见窗口（rAF 节流）；容器尺寸变化同样重绘
    const treeEl = mustQuery<HTMLElement>(root, '[data-tree]')
    treeEl.addEventListener(
      'scroll',
      () => {
        if (this.treeScrollRaf) return
        this.treeScrollRaf = requestAnimationFrame(() => {
          this.treeScrollRaf = 0
          this.renderTreeWindow()
        })
      },
      { passive: true },
    )
    new ResizeObserver(() => this.renderTreeWindow()).observe(treeEl)
    // 全文搜索：输入防抖搜索；Enter 打开首个结果；Escape/清除还原文件树
    const sideSearch = mustQuery<HTMLInputElement>(root, '[data-side-search]')
    sideSearch.addEventListener('input', () => {
      this.searchQuery = sideSearch.value.trim()
      this.updateSearchClearBtn(!!this.searchQuery)
      clearTimer(this.searchTimer)
      if (!this.searchQuery) {
        this.clearSearch()
        return
      }
      this.searchTimer = setTimeout(() => this.runSearch(false), 200)
    })
    sideSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.runSearch(true)
      } else if (e.key === 'Escape') {
        this.clearSearch()
        sideSearch.blur()
      }
    })
    mustQuery(root, '[data-search-clear]').addEventListener('click', () => {
      this.clearSearch()
      sideSearch.focus()
    })
    mustQuery(root, '[data-search-results]').addEventListener('click', (e) => {
      const item = targetClosest<HTMLElement>(e, '[data-sr-path]')
      if (item?.dataset.srPath) void this.openNote(item.dataset.srPath)
    })
    mustQuery(root, '[data-sort-menu]').addEventListener('click', (e) => {
      const item = targetClosest<HTMLElement>(e, '[data-opt]')
      if (!item) return
      const opt = SORT_OPTIONS[Number(item.dataset.opt)]
      if (!opt) return
      this.sortKey = opt.key
      this.sortDir = opt.dir
      this.sortCache.clear() // 排序键变化 → 全部缓存失效
      this.renderTree()
      this.hideSortMenu()
    })
    mustQuery(root, '[data-ctx]').addEventListener('click', (e) => {
      const item = targetClosest<HTMLElement>(e, '[data-ctx-act]')
      if (!item) return
      const act = item.dataset.ctxAct as CtxAction
      const c = this.context
      this.hideContext()
      if (c) void this.ctxAction(act, c.path, c.kind)
    })
    mustQuery(root, '[data-modal-cancel]').addEventListener('click', () => this.closeDialog())
    mustQuery(root, '[data-modal-ok]').addEventListener('click', () => this.confirmDialog())
    mustQuery(root, '[data-modal-folderlist]').addEventListener('click', (e) => {
      const opt = targetClosest<HTMLElement>(e, '[data-folder-opt]')
      if (!opt) return
      root.querySelectorAll('[data-folder-opt]').forEach((o) => o.classList.toggle('on', o === opt))
      if (this.dialog) this.dialog.folderValue = opt.dataset.folderOpt
    })
    mustQuery(root, '[data-modal-input]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirmDialog()
      if (e.key === 'Escape') this.closeDialog()
    })
    mustQuery(root, '[data-overlay]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirmDialog()
      if (e.key === 'Escape') this.closeDialog()
    })
    root.addEventListener('click', (e) => {
      if (!targetClosest(e, '[data-sort-menu]') && !targetClosest(e, '[data-act="sort"]')) this.hideSortMenu()
      if (!targetClosest(e, '[data-more-menu]') && !targetClosest(e, '[data-head-act="more"]') && !targetClosest(e, '.card-more')) this.hideMoreMenu()
      if (!targetClosest(e, '[data-ctx]')) this.hideContext()
      if (!targetClosest(e, '[data-edit-menu]') && !targetClosest(e, '.edit-sub')) this.hideEditMenu()
    })
    root.addEventListener('keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Escape') this.hideEditMenu()
    })
    root.addEventListener('contextmenu', (e) => {
      if (!targetClosest(e, '[data-tree]')) this.hideContext()
    })
  }

  // ---------- 树 ----------
  async loadDir(dir: string): Promise<void> {
    try {
      const entries = await window.api.pluginFiles.list(PLUGIN_ID, dir === ROOT ? undefined : dir)
      // 防御：主进程契约返回正斜杠路径，这里再归一化一次，避免 Windows 反斜杠破坏 `/` 路径逻辑
      this.tree.set(dir, entries.map((x) => ({ ...x, path: normalizePath(x.path) })))
      this.invalidateSort(dir) // 目录内容变化 → 排序缓存失效
      this.ensureIndexed(entries) // 全文索引增量（后台，mtime 比对）
      this.renderTree() // 合帧：内部 rAF 合并多次结构变化
    } catch (err) {
      console.error('[notes] loadDir', dir, err)
    }
  }

  sortEntries(entries: FileEntry[]): FileEntry[] {
    const a = [...entries]
    const keyOf = (x: FileEntry): string | number | undefined =>
      this.sortKey === 'created' ? x.createdMs : this.sortKey === 'modified' ? x.mtimeMs : x.name
    a.sort((x, y) => {
      const va = keyOf(x)
      const vb = keyOf(y)
      // 同一 keyOf 取值：va 为 string 时 vb 必为 string；va 非 string 时两者均为 number
      let c: number
      if (typeof va === 'string') c = va.localeCompare(vb as string, 'zh-CN')
      else c = (va ?? 0) - ((vb as number | undefined) ?? 0)
      if (x.isDirectory !== y.isDirectory) return x.isDirectory ? -1 : 1 // 文件夹永远在前
      return c * this.sortDir
    })
    return a
  }

  /** 目录排序缓存键：同一 (dir, sortKey, sortDir) 只排序一次（万级文件不重复 localeCompare） */
  private sortKeyOf(dir: string): string {
    return dir + '\u0000' + this.sortKey + '\u0000' + this.sortDir
  }

  getSorted(dir: string): FileEntry[] {
    const key = this.sortKeyOf(dir)
    const hit = this.sortCache.get(key)
    if (hit) return hit
    const sorted = this.sortEntries(this.tree.get(dir) ?? [])
    this.sortCache.set(key, sorted)
    return sorted
  }

  /** 目录内容变化 → 该目录的排序缓存失效（loadDir 时调用） */
  invalidateSort(dir: string): void {
    for (const key of [...this.sortCache.keys()]) {
      if (key.startsWith(dir + '\u0000')) this.sortCache.delete(key)
    }
  }

  /** 文件树渲染入口：rAF 合帧（多次结构变化合并到一帧重绘），内部重建扁平行 + 重绘窗口 */
  renderTree(): void {
    if (this.treeRenderRaf) return
    this.treeRenderRaf = requestAnimationFrame(() => {
      this.treeRenderRaf = 0
      this.rebuildFlatRows()
      this.renderTreeWindow()
    })
  }

  /** 从 tree+expanded+filter 重建扁平行模型（过滤时目录匹配带 memo，避免重复递归） */
  rebuildFlatRows(): void {
    const q = this.filter
    const rows: FlatRow[] = []
    const matchMemo = new Map<string, boolean>()
    const fileMatches = (x: FileEntry) => x.name.toLowerCase().includes(q)
    const dirHasMatch = (path: string): boolean => {
      const hit = matchMemo.get(path)
      if (hit !== undefined) return hit
      const m = this.getSorted(path).some((x) => (x.isDirectory ? dirHasMatch(x.path) : fileMatches(x)))
      matchMemo.set(path, m)
      return m
    }
    const walk = (dir: string, depth: number): void => {
      const entries = this.getSorted(dir)
      for (const x of entries) {
        if (!q) {
          // 无搜索：全部渲染
        } else if (x.isDirectory) {
          if (!fileMatches(x) && !dirHasMatch(x.path)) continue // 文件夹自身或后代无匹配则隐藏
          if (this.expanded.has(x.path) && !this.tree.has(x.path)) void this.loadDir(x.path) // 保证结果可见
        } else if (!fileMatches(x)) {
          continue
        }
        const isFolder = x.isDirectory
        rows.push({
          path: x.path,
          kind: isFolder ? 'folder' : 'file',
          depth,
          name: x.name.replace(/\.md$/, ''),
          expanded: isFolder && this.expanded.has(x.path),
          sel: this.selectedItem === x.path,
          cur: !isFolder && this.current === x.path,
        })
        if (isFolder && this.expanded.has(x.path)) walk(x.path, depth + 1)
      }
    }
    walk(ROOT, 0)
    this.flatRows = rows
  }

  /** 单行 HTML（虚拟化窗口内的行；事件委托 targetClosest('[data-path]') 天然兼容窗口化） */
  private flatRowHtml(r: FlatRow, q: string): string {
    const cls = ['t-row']
    if (r.kind === 'folder') cls.push('folder')
    if (r.sel || this.multiSel.has(r.path)) cls.push('sel') // 主选中或 Shift/Ctrl 多选均高亮
    if (r.cur) cls.push('cur')
    const indent = 'padding-left:' + (r.depth * 14 + 4) + 'px'
    const caret = r.kind === 'folder' ? (r.expanded ? '▾' : '▸') : ''
    return `<div class="${cls.join(' ')}" style="${indent}" data-path="${escapeAttr(r.path)}" data-kind="${r.kind}" title="${escapeAttr(r.path)}" ${r.kind === 'file' ? 'draggable="true"' : ''}>
      <span class="caret">${caret}</span>
      <span class="ic">${r.kind === 'folder' ? ICON_FOLDER_SM : ICON_DOC_SM}</span>
      <span class="nm">${highlightMatch(r.name, q)}</span>
    </div>`
  }

  /** 重绘可见窗口行：scrollTop 映射到行区间，spacer 撑起未渲染区；滚动时 rAF 节流调用 */
  renderTreeWindow(): void {
    const tree = mustQuery<HTMLElement>(this.sr, '[data-tree]')
    const q = this.filter
    const total = this.flatRows.length
    if (total === 0) {
      tree.innerHTML = `<div class="t-empty">${q ? '没有匹配项。' : '还没有内容。点上方按钮新建。'}</div>`
      return
    }
    const viewH = tree.clientHeight || 0
    // 钳制 scrollTop：行数收缩（折叠/过滤）后防止越界
    const maxScroll = Math.max(0, total * ROW_H - viewH)
    if (tree.scrollTop > maxScroll) tree.scrollTop = maxScroll
    const start = Math.max(0, Math.floor(tree.scrollTop / ROW_H) - OVERSAN)
    const end = Math.min(total, Math.ceil((tree.scrollTop + viewH) / ROW_H) + OVERSAN)
    const html: string[] = []
    if (start > 0) html.push(`<div class="tree-spacer" style="height:${start * ROW_H}px"></div>`)
    for (let i = start; i < end; i++) html.push(this.flatRowHtml(this.flatRows[i], q))
    if (end < total) html.push(`<div class="tree-spacer" style="height:${(total - end) * ROW_H}px"></div>`)
    tree.innerHTML = html.join('')
  }

  /** 当前选中集（主选中 + 多选），去重保序 */
  private effectiveSelection(): string[] {
    const set = new Set<string>()
    if (this.selectedItem) set.add(this.selectedItem)
    for (const p of this.multiSel) set.add(p)
    return [...set]
  }

  /** Shift 连选：按 flatRows 视口顺序从锚点行到当前行全选（锚点缺省/失效则只选当前行）；不触发打开/展开 */
  private rangeSelect(path: string): void {
    const idx = this.flatRows.findIndex((r) => r.path === path)
    const anchorIdx = this.selAnchor ? this.flatRows.findIndex((r) => r.path === this.selAnchor) : -1
    const from = anchorIdx >= 0 ? Math.min(anchorIdx, idx) : idx
    const to = anchorIdx >= 0 ? Math.max(anchorIdx, idx) : idx
    this.multiSel.clear()
    for (let i = from; i <= to; i++) this.multiSel.add(this.flatRows[i].path)
    this.selectedItem = path // 主选中 = 最后点击的行
    this.selAnchor = path
    this.renderTreeWindow()
  }

  /** Ctrl/Cmd 切换：该行加入/移出多选；主选中被切掉时从剩余选中里重选主选中 */
  private toggleSelect(path: string): void {
    if (this.multiSel.has(path)) {
      this.multiSel.delete(path)
      if (this.selectedItem === path) {
        const rest = this.effectiveSelection()
        this.selectedItem = rest.length ? rest[rest.length - 1] : null
      }
    } else if (this.selectedItem === path) {
      this.selectedItem = null // 主选中单独被切掉（允许清空选中）
    } else {
      this.multiSel.add(path)
    }
    this.renderTreeWindow()
  }

  async selectFolder(path: string): Promise<void> {
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

  toggleExpandAll(): void {
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

  setExpandIcon(expanded: boolean): void {
    const btn = this.sr.querySelector<HTMLElement>('[data-act="expand"]')
    if (!btn) return
    btn.innerHTML = expanded ? ICON_COLLAPSE : ICON_EXPAND
    btn.title = expanded ? '全部收起' : '全展开'
    btn.setAttribute('aria-label', btn.title)
  }

  toggleSide(): void {
    this.sideCollapsed = !this.sideCollapsed
    const side = mustQuery<HTMLElement>(this.sr, '.side')
    const btn = mustQuery<HTMLElement>(this.sr, '[data-act="toggle-side"]')
    const splitter = mustQuery<HTMLElement>(this.sr, '[data-splitter]')
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

  startSplitDrag(e: MouseEvent): void {
    e.preventDefault()
    const splitter = mustQuery<HTMLElement>(this.sr, '[data-splitter]')
    const side = mustQuery<HTMLElement>(this.sr, '.side')
    const appRect = mustQuery<HTMLElement>(this.sr, '.app').getBoundingClientRect()
    splitter.classList.add('dragging')
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      // 最小宽度 = 折叠按钮窄条宽度（30px），再左拖即贴到最窄
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
  setPaneMode(paneId: string | null | undefined, mode: PaneMode): void {
    const rec = paneId ? this.panes.get(paneId) : undefined
    if (!rec) return
    if (rec.mode === mode) {
      this.renderMoreMenu(paneId)
      return
    }
    rec.mode = mode
    if (rec.editor && rec.liveCompartment) {
      rec.live = mode === 'normal'
      rec.editor.dispatch({ effects: rec.liveCompartment.reconfigure(rec.live ? livePreviewExt() : []) })
    }
    // 统一入口：updateHead() 重建卡片 DOM（data-mode 由 renderCard 从 rec.mode 恢复）+ 刷新各卡片预览。
    // 注意：预览渲染必须发生在重建之后，否则渲染结果会被整卡重建清空（旧实现顺序相反导致预览空白）。
    this.updateHead()
    this.renderMoreMenu(paneId)
    rec.editor?.focus()
  }

  /** 分屏：把当前卡片在当前笔记处一分为二（并排/上下）。左卡片保留原全部标签，右卡片只有当前笔记一个标签 */
  async splitActive(dir: SplitDir): Promise<void> {
    const card = this.ensureCard()
    const active = card.activePaneId ? this.panes.get(card.activePaneId) : undefined
    if (!active) return
    const newCard = this.createCard() // 右/下卡片：只含当前笔记
    const dup = this.addTab(newCard.id)
    dup.mode = active.mode
    const splitNode: SplitTree = { type: 'split', dir, children: [{ type: 'leaf', cardId: card.id }, { type: 'leaf', cardId: newCard.id }] }
    if (this.splitRoot) this.replaceLeaf(card.id, splitNode)
    else this.splitRoot = splitNode
    this.activeCardId = newCard.id
    this.activePaneId = dup.id
    this.updateHead() // 单次重建 + 刷新（旧卡片预览不再因重建丢失）
    if (active.path) await this.openInPane(dup.id, active.path)
    this.renderMoreMenu()
  }

  /** 分屏树工具：把含 cardId 的叶子替换为 newNode（递归） */
  replaceLeaf(cardId: string, newNode: SplitTree): void {
    const replace = (node: SplitTree | null): SplitTree | null => {
      if (!node) return null
      if (node.type === 'leaf') return node.cardId === cardId ? newNode : node
      const a = replace(node.children[0])
      const b = replace(node.children[1])
      if (a !== node.children[0] || b !== node.children[1]) node.children = [a ?? node.children[0], b ?? node.children[1]]
      return node
    }
    this.splitRoot = replace(this.splitRoot)
  }

  /** 分屏分割线拖动：调整该 split 层级两侧面板的大小（左右/上下） */
  startDividerDrag(e: MouseEvent, divider: HTMLElement): void {
    e.preventDefault()
    const split = divider.parentElement as SplitElement | null
    if (!split) return
    const dir = split.dataset.dir
    const first = split.children[0] as HTMLElement
    const splitRect = split.getBoundingClientRect()
    const min = 80
    const max = dir === 'row' ? splitRect.width : splitRect.height
    divider.classList.add('dragging')
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
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

  toggleMoreMenu(anchor: HTMLElement, paneId: string | null | undefined): void {
    const menu = mustQuery<HTMLElement>(this.sr, '[data-more-menu]')
    if (menu.classList.contains('show')) {
      this.hideMoreMenu()
      return
    }
    this.renderMoreMenu(paneId)
    const host = mustQuery<HTMLElement>(this.sr, '.app').getBoundingClientRect()
    const rect = anchor.getBoundingClientRect()
    menu.style.left = Math.max(0, rect.right - host.left - 160) + 'px'
    menu.style.top = rect.bottom - host.top + 4 + 'px'
    menu.classList.add('show')
  }

  renderMoreMenu(paneId?: string | null): void {
    const menu = mustQuery<HTMLElement>(this.sr, '[data-more-menu]')
    const items: Array<{ act: MoreAction; label: string; icon: string }> = [
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

  moreActive(act: MoreAction, paneId?: string | null): boolean {
    if (act === 'nav') {
      const pane = paneId ? this.panes.get(paneId) : undefined
      return pane?.cardId ? (this.cards.get(pane.cardId)?.navOpen ?? false) : false
    }
    const pid = paneId ?? this.activePaneId
    const pane = pid ? this.panes.get(pid) : undefined
    return pane?.mode === act
  }

  moreAction(act: MoreAction, paneId: string | null | undefined): void {
    if (act === 'normal' || act === 'source' || act === 'preview') return this.setPaneMode(paneId, act)
    if (act === 'split') return void this.splitActive('row')
    if (act === 'split-v') return void this.splitActive('column')
    if (act === 'nav') return this.toggleNav(paneId ? this.panes.get(paneId)?.cardId : undefined)
  }

  hideMoreMenu(): void {
    mustQuery<HTMLElement>(this.sr, '[data-more-menu]').classList.remove('show')
  }

  toggleNav(cardId?: string | null): void {
    const card = (cardId ? this.cards.get(cardId) : undefined) ?? this.ensureCard()
    card.navOpen = !card.navOpen
    // 重建（导航栏随 renderCard 显隐）+ 刷新预览/大纲；预览渲染必须在重建之后
    this.updateHead()
    this.renderMoreMenu()
  }

  renderPreview(paneId?: string | null): void {
    const pid = paneId ?? this.activePaneId
    const rec = pid ? this.panes.get(pid) : undefined
    if (!rec) return
    const card = rec.cardId ? this.cards.get(rec.cardId) : undefined
    const target = card ? (card.activePaneId ? this.panes.get(card.activePaneId) : undefined) : rec
    if (!target) return
    const preview = rec.cardId ? this.sr.querySelector<HTMLElement>(`[data-card-id="${rec.cardId}"] [data-preview]`) : null
    if (!preview) return
    const content = target.editor?.state.doc.toString() ?? ''
    // 内容未变 → 只注入缓存 HTML（renderMarkdown/DOMPurify 不重跑）；缓存键绑 target（实际展示的面板）
    if (target.previewCache && target.previewCache.text === content) {
      preview.innerHTML = target.previewCache.html
    } else {
      const raw = content ? renderMarkdown(content) : ''
      // KaTeX 需要 style 属性、MathML 注解标签；其余走 DOMPurify 默认白名单（details/summary 默认放行）
      const safe = content
        ? DOMPurify.sanitize(raw, {
            ADD_ATTR: ['style'],
            ADD_TAGS: ['annotation', 'semantics', 'mspace', 'mpadded', 'mphantom', 'menclose'],
          })
        : ''
      target.previewCache = { text: content, html: safe }
      preview.innerHTML = safe
    }
    void hydrateMermaid(preview) // 懒加载渲染 ```mermaid（缓存命中重注入后同样触发）
    // 该卡片导航开着 → 应用该卡片自己的搜索高亮 + 重建大纲
    if (card && card.navOpen && target.id === card.activePaneId) {
      this.applyNavHighlight(card)
      this.renderOutline(card)
    }
  }

  /** 还原导航高亮：把上次的 <mark class="nav-hl"> 恢复为原文文本节点（清空查询后不留残留） */
  unwrapAllMarks(el: HTMLElement): void {
    for (const m of [...el.querySelectorAll('mark.nav-hl')]) m.replaceWith(...m.childNodes)
  }

  /** 导航搜索统一入口（含门）：内容与查询都未变则跳过重建；否则还原旧高亮 + 重新高亮 + 重建大纲 */
  refreshNav(card: CardRecord): void {
    const target = card.activePaneId ? this.panes.get(card.activePaneId) : undefined
    if (!target) return
    const preview = this.sr.querySelector<HTMLElement>(`[data-card-id="${card.id}"] [data-preview]`)
    if (!preview) return
    const content = target.editor?.state.doc.toString() ?? ''
    if (card.outlineCacheText === content && card.lastNavQuery === card.navQuery) return
    card.outlineCacheText = content
    card.lastNavQuery = card.navQuery
    this.applyNavHighlight(card)
    this.renderOutline(card)
  }

  /** 在指定卡片的预览上高亮该卡片的搜索词（匹配数封顶 MAX_HL=300，跳过 pre/code/script/style） */
  applyNavHighlight(card: CardRecord): void {
    const preview = this.sr.querySelector<HTMLElement>(`[data-card-id="${card.id}"] [data-preview]`)
    if (!preview) return
    this.unwrapAllMarks(preview) // 先还原上次高亮，避免查询清空/变化后 <mark> 残留
    const q = card.navQuery
    if (!q) return
    const target = card.activePaneId ? this.panes.get(card.activePaneId) : undefined
    if (!target) return
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT)
    const targets: Text[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeType !== Node.TEXT_NODE) continue
      if (node.parentElement?.closest('pre, code, script, style, .katex')) continue // 代码/数学公式不高亮
      targets.push(node as Text)
    }
    const MAX_HL = 300 // 高亮匹配数封顶：超长文档不卡
    let hl = 0
    for (const node of targets) {
      if (hl >= MAX_HL) break
      const text = node.textContent ?? ''
      const lower = text.toLowerCase()
      let idx = lower.indexOf(q)
      if (idx === -1) continue
      const frag = document.createDocumentFragment()
      let i = 0
      while (idx !== -1 && hl < MAX_HL) {
        if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)))
        const mark = document.createElement('mark')
        mark.className = 'nav-hl'
        mark.textContent = text.slice(idx, idx + q.length)
        frag.appendChild(mark)
        i = idx + q.length
        hl++
        idx = lower.indexOf(q, i)
      }
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)))
      node.parentNode?.replaceChild(frag, node)
    }
  }

  /** 重建指定卡片的标题大纲（按该卡片搜索词过滤），渲染到该卡片的导航区 */
  renderOutline(card: CardRecord): void {
    const target = card.activePaneId ? this.panes.get(card.activePaneId) : undefined
    if (!target) return
    const preview = this.sr.querySelector<HTMLElement>(`[data-card-id="${card.id}"] [data-preview]`)
    if (!preview) return
    card.outline = [...preview.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].map((el) => ({
      el,
      level: Number(el.tagName[1]),
      text: el.textContent || '',
    }))
    const box = this.sr.querySelector<HTMLElement>(`[data-card-nav-outline="${card.id}"]`)
    if (!box) return
    const q = card.navQuery
    if (!card.outline.length) {
      box.innerHTML = '<div class="nav-empty">暂无标题大纲。</div>'
      return
    }
    const items = card.outline.map((o, i) => ({ o, i })).filter(({ o }) => !q || o.text.toLowerCase().includes(q))
    if (!items.length) {
      box.innerHTML = '<div class="nav-empty">没有匹配的标题。</div>'
      return
    }
    box.innerHTML = items
      .map(
        ({ o, i }) =>
          `<div class="nav-item" data-card-nav-idx="${i}" style="padding-left:${(o.level - 1) * 12 + 8}px">${highlightMatch(o.text, q)}</div>`,
      )
      .join('')
  }

  collectFolders(): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const x of this.tree.get(dir) ?? []) {
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
  async newEntry(kind: 'file' | 'folder'): Promise<void> {
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
        void this.selectFolder(rel)
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
  async newNoteFromPane(paneId?: string | null): Promise<void> {
    const rec = (paneId ? this.panes.get(paneId) : undefined) ?? this.ensurePane()
    const card = (rec.cardId ? this.cards.get(rec.cardId) : undefined) ?? this.ensureCard()
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
      await this.openInPane(tab.id, rel)
    } catch (err) {
      console.error('[notes] 新建失败（可能已存在）', err)
    }
  }

  // ---------- 打开/编辑 ----------
  async openNote(path: string): Promise<void> {
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
    await this.openInPane(tab.id, path)
  }

  /** 多开：在 afterPaneId 所在卡片里新开一个标签（插到该页签之后）；已打开则切到其标签 */
  async openAsTab(path: string, afterPaneId: string | null = null): Promise<void> {
    for (const rec of this.panes.values()) {
      if (rec.path === path) {
        this.activatePane(rec.id)
        return
      }
    }
    const afterRec = afterPaneId ? this.panes.get(afterPaneId) : null
    const card = afterRec ? ((afterRec.cardId ? this.cards.get(afterRec.cardId) : undefined) ?? this.ensureCard()) : this.ensureCard()
    const tab = this.createPane()
    tab.cardId = card.id
    const idx = afterPaneId ? card.paneIds.indexOf(afterPaneId) : -1
    if (idx >= 0) card.paneIds.splice(idx + 1, 0, tab.id)
    else card.paneIds.push(tab.id)
    card.activePaneId = tab.id
    this.activeCardId = card.id
    this.activePaneId = tab.id
    this.updateHead()
    await this.openInPane(tab.id, path)
  }

  // ---------- 多开拆分面板 ----------
  updatePaneTitle(_paneId: string): void {
    this.updateHead() // 卡片标签/路径随重渲染刷新（重命名/移动/换笔记时）；统一入口含预览刷新
  }

  /** 重渲染卡片（标签栏/路径栏都在卡片内）；统一入口 = 重建 DOM + 刷新各卡片预览。
   * 所有会重建卡片 DOM 的调用点都应走这里（而非裸 renderSplit），否则预览/导航内容会被清空。 */
  updateHead(): void {
    this.renderSplit()
    this.refreshAllPreviews()
  }

  /** 重建后按需重刷预览：仅对可见卡片中「预览模式或导航打开」的激活标签重渲染（含大纲/搜索高亮） */
  refreshAllPreviews(): void {
    const ids = this.splitCardIds()
    if (ids.size === 0) {
      const card = this.activeCard
      if (card) ids.add(card.id)
    }
    for (const id of ids) {
      const card = this.cards.get(id)
      const rec = card?.activePaneId ? this.panes.get(card.activePaneId) : undefined
      if (rec && (rec.mode === 'preview' || card?.navOpen)) this.renderPreview(rec.id)
    }
  }

  /** 渲染 .main：普通态只显示激活卡片；分屏态渲染分屏树 */
  renderSplit(): void {
    const main = mustQuery<HTMLElement>(this.sr, '[data-split-root]')
    main.innerHTML = ''
    if (this.splitRoot) {
      main.appendChild(this.renderSplitNode(this.splitRoot))
      return
    }
    const card = this.activeCard
    if (!card || card.paneIds.length === 0) {
      main.innerHTML = '<div class="placeholder">选择或新建一篇笔记开始。</div>'
      return
    }
    main.appendChild(this.renderCard(card.id))
  }

  renderSplitNode(node: SplitTree): SplitElement {
    if (node.type === 'leaf') return this.renderCard(node.cardId) as SplitElement
    const div = document.createElement('div') as SplitElement
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

  /** 渲染一张分屏卡片：自带标签栏（多标签+新建）+ 路径栏 + 编辑器（激活标签）+ 预览 + 可选导航 */
  renderCard(cardId: string): HTMLElement {
    const card = this.cards.get(cardId)
    const el = document.createElement('div')
    el.className = 'card' + (cardId === this.activeCardId ? ' active' : '')
    el.dataset.cardId = cardId
    if (!card || card.paneIds.length === 0) {
      el.innerHTML = '<div class="placeholder">选择或新建一篇笔记开始。</div>'
      return el
    }
    const pane = card.activePaneId ? this.panes.get(card.activePaneId) : undefined
    el.dataset.mode = pane?.mode ?? 'normal' // 显示模式（normal/source/preview）随激活标签
    // 卡片标签栏：该卡片打开的笔记页签 + 新建
    const tabs = document.createElement('div')
    tabs.className = 'card-tabs'
    tabs.innerHTML =
      card.paneIds
        .map((id) => {
          const r = this.panes.get(id)
          const name = r?.path ? r.path.split('/').pop()!.replace(/\.md$/, '') : '分屏'
          const active = id === card.activePaneId
          return `<span class="ctab${active ? ' active' : ''}" data-card-tab="${id}" title="${escapeAttr(r?.path ?? '')}"><span class="ctab-name">${escapeHtml(name)}</span><button type="button" class="ctab-close" data-card-tab-close="${id}" title="关闭" aria-label="关闭">×</button></span>`
        })
        .join('') +
      '<button type="button" class="ctab-new" data-card-new title="在该卡片新建笔记" aria-label="新建笔记">' + ICON_PLUS + '</button>'
    el.appendChild(tabs)
    // 卡片路径栏
    const page = document.createElement('div')
    page.className = 'card-page'
    page.innerHTML = `<span class="card-crumb">${pane?.path ? escapeHtml(pane.path.replace(/\.md$/, '')) : ''}</span><button type="button" class="card-more" data-card-more title="更多" aria-label="更多">${ICON_MORE}</button>`
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
    editorCol.appendChild(preview)
    body.appendChild(editorCol)
    if (card.navOpen) {
      const nav = document.createElement('div')
      nav.className = 'card-nav'
      nav.innerHTML =
        `<div class="card-nav-toolbar"><input class="card-nav-search" data-card-nav-search="${card.id}" value="${escapeAttr(card.navQuery)}" placeholder="搜索…" spellcheck="false" /><button type="button" class="card-nav-clear${card.navQuery ? ' show' : ''}" data-card-nav-clear="${card.id}" title="清除搜索" aria-label="清除搜索">×</button></div>` +
        `<div class="card-nav-outline" data-card-nav-outline="${card.id}"></div>`
      body.appendChild(nav)
    }
    el.appendChild(body)
    return el
  }

  /** 当前分屏树里的所有卡片 id（无分屏 → 空 Set） */
  splitCardIds(): Set<string> {
    const ids = new Set<string>()
    if (!this.splitRoot) return ids
    const walk = (n: SplitTree): void => {
      if (n.type === 'leaf') ids.add(n.cardId)
      else n.children.forEach(walk)
    }
    walk(this.splitRoot)
    return ids
  }

  /** 判断 paneId 所在的卡片是否在分屏树里 */
  splitContains(paneId: string): boolean {
    const rec = this.panes.get(paneId)
    if (!rec) return false
    return this.splitCardIds().has(rec.cardId ?? '')
  }

  createPane(): PaneRecord {
    const rec: PaneRecord = { id: 'pane-' + this.nextPaneId++, cardId: null, path: null, mode: 'normal', editor: null, saveTimer: null, liveCompartment: null, live: false, lastSavedText: null, previewCache: null }
    this.panes.set(rec.id, rec)
    return rec
  }

  /** 新建一张分屏卡片（含独立标签栏） */
  createCard(): CardRecord {
    const card: CardRecord = { id: 'card-' + this.nextCardId++, paneIds: [], activePaneId: null, navOpen: false, navQuery: '', navTimer: null, outline: [] }
    this.cards.set(card.id, card)
    return card
  }

  /** 保证至少一张卡片存在且 activeCardId 有效 */
  ensureCard(): CardRecord {
    if (this.cards.size === 0) {
      const card = this.createCard()
      this.activeCardId = card.id
      return card
    }
    if (!this.activeCardId || !this.cards.has(this.activeCardId)) {
      this.activeCardId = [...this.cards.keys()][0] ?? null
    }
    return this.cards.get(this.activeCardId ?? '')!
  }

  /** 在指定卡片里新增一个标签（返回新 pane），并把该卡片的激活标签设为新标签 */
  addTab(cardId: string): PaneRecord {
    const card = this.cards.get(cardId) ?? this.ensureCard()
    const rec = this.createPane()
    rec.cardId = card.id
    card.paneIds.push(rec.id)
    card.activePaneId = rec.id
    return rec
  }

  /** 保证至少一个标签存在，且 activePaneId / activeCardId 有效 */
  ensurePane(): PaneRecord {
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
    return this.panes.get(this.activePaneId ?? '')!
  }

  /** 关闭标签：落盘（可 discard）→ 从卡片移除；卡片只剩一页关掉 → 该卡片/分屏关闭；激活重指派 */
  async closePane(paneId: string | undefined, { discard = false }: { discard?: boolean } = {}): Promise<void> {
    const rec = paneId ? this.panes.get(paneId) : undefined
    if (!rec) return
    clearTimer(rec.saveTimer)
    if (!discard && rec.path && rec.editor) {
      try {
        await this.writeIfDirty(rec) // 脏检查：未修改不写盘
      } catch {
        /* 落盘失败忽略 */
      }
    }
    rec.editor?.destroy()
    this.panes.delete(paneId!)
    const card = rec.cardId ? this.cards.get(rec.cardId) : undefined
    if (card) {
      card.paneIds = card.paneIds.filter((id) => id !== paneId)
      if (card.paneIds.length === 0) {
        // 卡片已空 → 删除卡片；分屏树就地折叠；只剩单卡片 → 回到单卡片模式
        clearTimer(card.navTimer)
        this.cards.delete(card.id)
        if (this.splitRoot) {
          const collapsed = removeLeaf(this.splitRoot, card.id)
          if (collapsed && collapsed.type === 'split') this.splitRoot = collapsed
          else this.splitRoot = null
        }
        if (this.activeCardId === card.id) {
          this.activeCardId = [...this.cards.keys()][0] ?? null
          this.activePaneId = this.activeCardId ? (this.cards.get(this.activeCardId)?.activePaneId ?? null) : null
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
      this.updateHead() // 占位渲染（无卡片可刷预览）
      this.renderTree()
      return
    }
    this.updateHead() // 重建 + 刷新剩余卡片的预览
    this.activePane?.editor?.focus()
    this.renderTree()
  }

  /** 打开 path 到指定标签（替换其内容），并设为该卡片激活标签 */
  async openInPane(paneId: string, path: string): Promise<void> {
    const rec = this.panes.get(paneId)
    if (!rec) return
    const card = rec.cardId ? this.cards.get(rec.cardId) : undefined
    if (card) card.activePaneId = rec.id
    await this.savePane(paneId)
    let content: string
    try {
      content = await window.api.pluginFiles.read(PLUGIN_ID, path)
    } catch (err) {
      console.error('[notes] 打开失败', path, err)
      return
    }
    // 已有标签打开同一文件时，用其内存中最新内容（分屏复制/二次打开避免读到旧落盘）
    const live = [...this.panes.values()].find((r) => r.id !== paneId && r.path === path && r.editor)
    if (live) content = live.editor!.state.doc.toString()
    rec.editor?.destroy()
    rec.path = path
    this.selectedItem = path
    const host = rec.cardId ? this.sr.querySelector<HTMLElement>(`[data-card-id="${rec.cardId}"] [data-editor]`) : null
    if (!host) this.updateHead() // 卡片 DOM 缺失（理论不发生）则补渲染（统一入口，预览不丢失）
    this.createEditorForPane(paneId, content)
    rec.lastSavedText = content // 读入即快照：未编辑不写回
    this.indexFromOpen(path, content) // 全文索引增量
    if (paneId === this.activePaneId) {
      this.updateHead() // 重建 + 刷新预览（预览/导航模式由 refreshAllPreviews 覆盖）
      this.renderTree()
    }
    rec.editor?.focus()
  }

  /** 拖到内容区：在鼠标落点插入 markdown 链接（拖到哪插到哪）；空面板退化为打开 */
  insertLinkAt(paneId: string, path: string, clientX: number, clientY: number): void {
    const rec = this.panes.get(paneId)
    if (!rec) return
    if (!rec.path) return void this.openInPane(paneId, path)
    if (!rec.editor) return
    const pos = rec.editor.posAtCoords({ x: clientX, y: clientY }) ?? rec.editor.state.selection.main.head
    const title = path.split('/').pop()!.replace(/\.md$/, '')
    const link = `[${title}](${path})`
    rec.editor.dispatch({
      changes: { from: pos, to: pos, insert: link },
      selection: { anchor: pos + link.length },
    })
    rec.editor.focus()
  }

  /** 切换激活标签：聚焦所在卡片并设其激活标签、重渲染（卡片内标签/路径刷新） */
  activatePane(paneId: string | null | undefined): void {
    if (!paneId || !this.panes.has(paneId) || paneId === this.activePaneId) return
    this.lastActivePaneId = this.activePaneId
    this.activePaneId = paneId
    const rec = this.panes.get(paneId)!
    const card = rec.cardId ? this.cards.get(rec.cardId) : undefined
    if (card) {
      card.activePaneId = paneId
      this.activeCardId = card.id
    }
    this.updateHead() // 重建 + 刷新预览（激活标签的预览/导航内容由 refreshAllPreviews 覆盖）
    this.renderTree()
    this.panes.get(paneId)?.editor?.focus()
  }

  // ---------- 每面板编辑器与保存 ----------
  createEditorForPane(paneId: string, doc: string): void {
    const rec = this.panes.get(paneId)
    const host = rec?.cardId ? this.sr.querySelector<HTMLElement>(`[data-card-id="${rec.cardId}"] [data-editor]`) : null
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
              const box = (e.target as HTMLElement | null)?.closest<HTMLElement>('.cm-task-box')
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
            click: (e, view) => {
              // 点击链接：内部笔记路径 → 打开笔记；外部 URL → 系统浏览器（普通/源文件模式均可）
              if (e.target instanceof Element && e.target.closest('.cm-task-box')) return false
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
              if (pos == null) return false
              const line = view.state.doc.lineAt(pos)
              const re = /\[[^\]]*\]\(<?([^)\s]+)>?\)|<(https?:\/\/[^>\s]+)>/g
              let m: RegExpExecArray | null
              while ((m = re.exec(line.text))) {
                const start = line.from + m.index
                const end = start + m[0].length
                if (pos >= start && pos <= end) {
                  const url = (m[1] ?? m[2] ?? '').trim()
                  if (url && !url.startsWith('#')) this.handleLinkClick(url)
                  return true
                }
              }
              return false
            },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            // 外部同步来的改动（其他分屏面板的编辑）：不转发、不由本面板落盘
            const external = u.transactions.some((tr) => tr.annotation(Sync))
            if (external) {
              rec.lastSavedText = u.state.doc.toString() // 外部同步：快照跟随（源面板负责落盘）
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
  syncPaneToOthers(paneId: string, transactions: readonly Transaction[]): void {
    const src = this.panes.get(paneId)
    if (!src?.path || !transactions.length) return
    for (const [id, rec] of this.panes) {
      if (id === paneId || rec.path !== src.path || !rec.editor) continue
      for (const tr of transactions) {
        rec.editor.dispatch({ changes: tr.changes, annotations: Sync.of(true) })
      }
    }
  }

  scheduleSavePane(paneId: string): void {
    const rec = this.panes.get(paneId)
    if (!rec) return
    clearTimer(rec.saveTimer)
    rec.saveTimer = setTimeout(() => void this.savePane(paneId), 600)
  }

  /** 预览模式或卡片导航开着时，才需要实时刷新预览/大纲/全文搜索 */
  needsLivePreview(rec: PaneRecord | null | undefined): boolean {
    const card = rec?.cardId ? this.cards.get(rec.cardId) : null
    return !!rec && (rec.mode === 'preview' || !!card?.navOpen)
  }

  schedulePreviewPane(paneId: string): void {
    clearTimer(this.previewTimer)
    this.previewTimer = setTimeout(() => {
      const rec = this.panes.get(paneId)
      if (this.needsLivePreview(rec)) this.renderPreview(paneId)
    }, 300)
  }

  /** 脏检查写盘：内容与磁盘快照一致则跳过 IPC；写成功后更新快照并同步全文索引 */
  async writeIfDirty(rec: PaneRecord): Promise<void> {
    if (!rec.path || !rec.editor) return
    const text = rec.editor.state.doc.toString()
    if (rec.lastSavedText === text) return
    try {
      await window.api.pluginFiles.write(PLUGIN_ID, rec.path, text)
      rec.lastSavedText = text
      this.indexFromSave(rec.path, text)
    } catch (err) {
      console.error('[notes] 保存失败', err)
    }
  }

  async savePane(paneId: string): Promise<void> {
    const rec = this.panes.get(paneId)
    if (!rec) return
    clearTimer(rec.saveTimer) // 取消防抖定时器：避免删除/切换后旧定时器把文件写回
    await this.writeIfDirty(rec)
  }

  saveAll(): Promise<void[]> {
    return Promise.all([...this.panes.keys()].map((id) => this.savePane(id)))
  }

  /** 兼容旧调用点：保存激活面板 */
  saveCurrent(): Promise<void> {
    return this.activePaneId ? this.savePane(this.activePaneId) : Promise.resolve()
  }

  // ---------- 全文搜索 ----------
  /** 后台全量建索引：BFS 收集所有 .md（复用树缓存，未加载目录按需 list），分批读取+索引让出主线程 */
  async buildFullIndex(): Promise<void> {
    const pending: Array<{ path: string; mtimeMs?: number }> = []
    const visited = new Set<string>()
    const queue = [ROOT]
    while (queue.length) {
      const dir = queue.shift()!
      if (visited.has(dir)) continue
      visited.add(dir)
      let entries: FileEntry[]
      try {
        entries = this.tree.has(dir)
          ? this.tree.get(dir)!
          : await window.api.pluginFiles.list(PLUGIN_ID, dir === ROOT ? undefined : dir)
        this.tree.set(dir, entries.map((x) => ({ ...x, path: normalizePath(x.path) })))
      } catch {
        continue
      }
      for (const x of entries) {
        if (x.isDirectory) queue.push(x.path)
        else if (x.path.toLowerCase().endsWith('.md')) pending.push({ path: x.path, mtimeMs: x.mtimeMs })
      }
      this.renderTree()
    }
    const BATCH = 20 // 每批 20 篇，批间 setTimeout(0) 让出主线程，UI 不卡
    for (let i = 0; i < pending.length; i += BATCH) {
      const chunk = pending.slice(i, i + BATCH)
      this.search.pending = pending.length - i
      this.updateSearchStatus()
      await Promise.all(
        chunk.map(async (f) => {
          try {
            const content = await window.api.pluginFiles.read(PLUGIN_ID, f.path)
            this.search.upsertIfChanged(f.path, content, f.mtimeMs)
          } catch {
            /* 读取失败跳过 */
          }
        }),
      )
      await new Promise((r) => setTimeout(r, 0))
    }
    this.search.pending = 0
    this.updateSearchStatus()
  }

  /** loadDir 后增量：新文件/变更文件（mtimeMs 变化）后台读取并入索引 */
  private ensureIndexed(entries: FileEntry[]): void {
    for (const x of entries) {
      if (x.isDirectory || !x.path.toLowerCase().endsWith('.md')) continue
      if (this.search.has(x.path) && this.search.mtime(x.path) === x.mtimeMs) continue
      void window.api.pluginFiles
        .read(PLUGIN_ID, x.path)
        .then((content) => this.search.upsertIfChanged(x.path, content, x.mtimeMs))
        .catch(() => {})
    }
  }

  /** 打开笔记后入索引（幂等：同 id 覆盖） */
  private indexFromOpen(path: string, content: string): void {
    this.search.add(path, content)
  }

  /** 保存成功后同步索引 */
  private indexFromSave(path: string, text: string): void {
    this.search.add(path, text)
  }

  /** 搜索：结果替换文件树展示（上限 100），点击/Enter 打开 */
  runSearch(openFirst = false): void {
    const q = this.searchQuery
    const box = mustQuery<HTMLElement>(this.sr, '[data-search-results]')
    const tree = mustQuery<HTMLElement>(this.sr, '[data-tree]')
    if (!q) return
    const results = this.search.search(q, 100)
    if (openFirst && results.length) {
      void this.openNote(results[0].path)
      return
    }
    tree.style.display = 'none'
    box.hidden = false
    box.innerHTML = results.length
      ? results
          .map((r) => {
            const crumb = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : ''
            return `<div class="sr-item" data-sr-path="${escapeAttr(r.path)}"><span class="sr-title">${highlightMatch(r.title, q)}</span>${crumb ? `<span class="sr-crumb">${escapeHtml(crumb)}</span>` : ''}</div>`
          })
          .join('')
      : '<div class="sr-empty">没有匹配的笔记。</div>'
  }

  /** 清空搜索：还原文件树 */
  clearSearch(): void {
    this.searchQuery = ''
    clearTimer(this.searchTimer)
    this.updateSearchClearBtn(false)
    const box = mustQuery<HTMLElement>(this.sr, '[data-search-results]')
    const tree = mustQuery<HTMLElement>(this.sr, '[data-tree]')
    const input = mustQuery<HTMLInputElement>(this.sr, '[data-side-search]')
    input.value = ''
    box.hidden = true
    box.innerHTML = ''
    tree.style.display = ''
    this.renderTree()
  }

  /** 搜索清除按钮显隐（有输入才显示 ×） */
  private updateSearchClearBtn(show: boolean): void {
    this.sr.querySelector<HTMLElement>('[data-search-clear]')?.classList.toggle('show', show)
  }

  /** 索引状态角标（后台建索引期间显示「索引中 (N)」） */
  private updateSearchStatus(): void {
    const el = this.sr.querySelector<HTMLElement>('[data-search-status]')
    if (!el) return
    if (this.search.pending > 0) {
      el.hidden = false
      el.textContent = `索引中 (${this.search.pending})`
    } else {
      el.hidden = true
    }
  }

  // ---------- 排序 ----------
  toggleSortMenu(e: MouseEvent): void {
    const menu = mustQuery<HTMLElement>(this.sr, '[data-sort-menu]')
    if (menu.classList.contains('show')) {
      this.hideSortMenu()
      return
    }
    menu.innerHTML = SORT_OPTIONS.map(
      (o, i) =>
        `<div class="menu-item${this.sortKey === o.key && this.sortDir === o.dir ? ' on' : ''}" data-opt="${i}">${o.label}</div>`,
    ).join('')
    const host = mustQuery<HTMLElement>(this.sr, '.app').getBoundingClientRect()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    menu.style.left = rect.left - host.left + 'px'
    menu.style.top = rect.bottom - host.top + 4 + 'px'
    menu.classList.add('show')
  }

  hideSortMenu(): void {
    mustQuery<HTMLElement>(this.sr, '[data-sort-menu]').classList.remove('show')
  }

  // ---------- 右键菜单 ----------
  showContext(e: MouseEvent, path: string, kind: string, paths?: string[]): void {
    const list = paths && paths.length ? paths : [path]
    this.context = { path, kind, paths: list }
    const ctx = mustQuery<HTMLElement>(this.sr, '[data-ctx]')
    const multi = list.length > 1
    // 多选：仅移动/删除（重命名无意义、复制按单选流程）；单选：完整四项
    const items = multi
      ? [
          { act: 'move', label: `移动 (${list.length} 项)`, icon: ICON_CTX_MOVE },
          { act: 'delete', label: `删除 (${list.length} 项)`, icon: ICON_CTX_DELETE },
        ]
      : [
          { act: 'copy', label: '复制', icon: ICON_CTX_COPY },
          { act: 'move', label: '移动', icon: ICON_CTX_MOVE },
          { act: 'rename', label: '重命名', icon: ICON_CTX_RENAME },
          { act: 'delete', label: '删除', icon: ICON_CTX_DELETE },
        ]
    ctx.innerHTML = items
      .map((x) => `<div class="menu-item${x.act === 'delete' ? ' danger' : ''}" data-ctx-act="${x.act}">${x.icon}<span>${x.label}</span></div>`)
      .join('')
    const host = mustQuery<HTMLElement>(this.sr, '.app').getBoundingClientRect()
    ctx.style.left = Math.min(e.clientX - host.left, host.width - 120) + 'px'
    ctx.style.top = Math.min(e.clientY - host.top, host.height - 150) + 'px'
    ctx.classList.add('show')
  }

  ctxLabel(a: CtxAction): string {
    return { copy: '复制', move: '移动', rename: '重命名', delete: '删除' }[a]
  }

  hideContext(): void {
    this.context = null
    mustQuery<HTMLElement>(this.sr, '[data-ctx]').classList.remove('show')
  }

  // ---------- 编辑区右键菜单 ----------
  showEditMenu(e: MouseEvent, paneId: string): void {
    this.editMenuPaneId = paneId
    this.renderEditMenu()
    this.hideContext()
    this.hideMoreMenu()
    const menu = mustQuery<HTMLElement>(this.sr, '[data-edit-menu]')
    const host = mustQuery<HTMLElement>(this.sr, '.app').getBoundingClientRect()
    const mw = menu.offsetWidth || 180
    const mh = menu.offsetHeight || 320
    menu.style.left = Math.min(e.clientX - host.left, host.width - mw - 4) + 'px'
    menu.style.top = Math.min(e.clientY - host.top, host.height - mh - 4) + 'px'
    menu.classList.add('show')
  }

  private renderEditMenu(): void {
    const sr = this.sr
    // 重建时清掉旧二级菜单
    for (const sub of [...sr.querySelectorAll<HTMLElement>('.edit-sub')]) sub.remove()
    const menu = mustQuery<HTMLElement>(sr, '[data-edit-menu]')
    // 二级菜单分组：悬停/点击分组项在右侧展开
    const SUB: Record<string, Array<{ act: string; label: string }>> = {
      format: [
        { act: 'bold', label: '加粗' },
        { act: 'italic', label: '斜体' },
        { act: 'strike', label: '删除线' },
        { act: 'code', label: '代码' },
        { act: 'math', label: '数学' },
        { act: 'comment', label: '注释' },
        { act: 'highlight', label: '高亮' },
      ],
      para: [
        { act: 'h1', label: '标题 1' },
        { act: 'h2', label: '标题 2' },
        { act: 'h3', label: '标题 3' },
        { act: 'h4', label: '标题 4' },
        { act: 'h5', label: '标题 5' },
        { act: 'h6', label: '标题 6' },
        { act: 'quote', label: '引用' },
        { act: 'ul', label: '无序列表' },
        { act: 'ol', label: '有序列表' },
      ],
      insert: [
        { act: 'footnote', label: '脚注' },
        { act: 'mark', label: '标注' },
        { act: 'image', label: '插入图片…' },
        { act: 'table', label: '表格' },
        { act: 'hr', label: '分割线' },
        { act: 'codeblock', label: '代码块' },
        { act: 'mathblock', label: '数学块' },
      ],
      clipboard: [
        { act: 'copy', label: '复制' },
        { act: 'cut', label: '剪切' },
        { act: 'paste', label: '粘贴' },
        { act: 'paste-plain', label: '以纯文本形式粘贴' },
        { act: 'select-all', label: '全选' },
      ],
    }
    menu.innerHTML = [
      '<div class="menu-item" data-edit-act="link-note">新增笔记链接…</div>',
      '<div class="menu-item" data-edit-act="link-url">新增外部链接…</div>',
      '<div class="menu-sep"></div>',
      '<div class="menu-item edit-has-sub" data-edit-group="format">文本格式<span class="edit-caret">▸</span></div>',
      '<div class="menu-item edit-has-sub" data-edit-group="para">段落设置<span class="edit-caret">▸</span></div>',
      '<div class="menu-item edit-has-sub" data-edit-group="insert">插入<span class="edit-caret">▸</span></div>',
      '<div class="menu-item edit-has-sub" data-edit-group="clipboard">剪贴板<span class="edit-caret">▸</span></div>',
    ].join('')
    menu.querySelectorAll<HTMLElement>('[data-edit-act]').forEach((el) =>
      el.addEventListener('click', () => {
        const pid = this.editMenuPaneId // 先捕获作用面板，再收起（hideEditMenu 会清空该字段）
        this.hideEditMenu()
        void this.editAction(el.dataset.editAct!, pid)
      }),
    )
    // 为每个分组创建独立二级菜单（挂 .app 下，避免被主菜单 overflow 裁剪）
    for (const key of Object.keys(SUB)) {
      const sub = document.createElement('div')
      sub.className = 'edit-menu edit-sub'
      sub.dataset.editSub = key
      sub.innerHTML = SUB[key].map((x) => `<div class="menu-item" data-edit-act="${x.act}">${x.label}</div>`).join('')
      sub.querySelectorAll<HTMLElement>('[data-edit-act]').forEach((el) =>
        el.addEventListener('click', () => {
          const pid = this.editMenuPaneId // 先捕获作用面板，再收起（hideEditMenu 会清空该字段）
          this.hideEditMenu()
          void this.editAction(el.dataset.editAct!, pid)
        }),
      )
      mustQuery<HTMLElement>(sr, '.app').appendChild(sub)
      const group = menu.querySelector<HTMLElement>(`[data-edit-group="${key}"]`)
      if (!group) continue
      // 悬停打开对应二级菜单；打开后保持（不随鼠标移开消失），
      // 仅「再次点击同一项 / 点击其它一级项 / 点击子项执行 / 点外部 / Esc」时关闭
      group.addEventListener('mouseenter', () => this.showSubmenu(key, group))
      group.addEventListener('click', (e) => {
        e.stopPropagation()
        if (sub.classList.contains('show')) this.hideSubmenu()
        else this.showSubmenu(key, group)
      })
    }
  }

  /** 展开指定二级菜单（并收起其它），位置跟随分组项右缘；分组项加选中态 .on */
  private showSubmenu(key: string, anchor: HTMLElement): void {
    for (const s of [...this.sr.querySelectorAll<HTMLElement>('.edit-sub')]) s.classList.toggle('show', s.dataset.editSub === key)
    for (const g of [...this.sr.querySelectorAll<HTMLElement>('[data-edit-group]')]) g.classList.toggle('on', g.dataset.editGroup === key)
    const sub = this.sr.querySelector<HTMLElement>(`.edit-sub[data-edit-sub="${key}"]`)
    if (!sub) return
    const rect = anchor.getBoundingClientRect()
    const host = mustQuery<HTMLElement>(this.sr, '.app').getBoundingClientRect()
    sub.style.left = Math.min(rect.right - host.left, host.width - (sub.offsetWidth || 160) - 4) + 'px'
    sub.style.top = Math.min(rect.top - host.top, host.height - (sub.offsetHeight || 320) - 4) + 'px'
  }

  private hideSubmenu(): void {
    for (const s of [...this.sr.querySelectorAll<HTMLElement>('.edit-sub')]) s.classList.remove('show')
    for (const g of [...this.sr.querySelectorAll<HTMLElement>('[data-edit-group]')]) g.classList.remove('on')
  }

  hideEditMenu(): void {
    this.editMenuPaneId = null
    for (const s of [...this.sr.querySelectorAll<HTMLElement>('.edit-sub')]) s.remove()
    mustQuery<HTMLElement>(this.sr, '[data-edit-menu]').classList.remove('show')
  }

  /** 执行编辑区右键动作（作用于 paneId 对应面板的编辑器） */
  private async editAction(act: string, paneId: string | null): Promise<void> {
    const rec = paneId ? this.panes.get(paneId) : undefined
    const view = rec?.editor
    if (!view) return
    const selText = (): string => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
    switch (act) {
      case 'link-note': {
        const path = await this.openNoteLinkDialog()
        if (path) this.insertAtCursor(view, `[${path.split('/').pop()!.replace(/\.md$/i, '')}](${path})`)
        break
      }
      case 'link-url': {
        const url = await this.openInputDialog('插入外部链接', 'https://…', 'https://')
        if (url) this.insertAtCursor(view, selText() ? `[${selText()}](${url})` : `[链接](${url})`)
        break
      }
      case 'image': {
        const url = await this.openInputDialog('插入图片', '图片 URL 或路径', '')
        if (url) this.insertAtCursor(view, `![${selText() || '图片'}](${url})`)
        break
      }
      case 'bold':
        this.wrapSelection(view, '**', '**')
        break
      case 'italic':
        this.wrapSelection(view, '*', '*')
        break
      case 'strike':
        this.wrapSelection(view, '~~', '~~')
        break
      case 'code':
        this.wrapSelection(view, '`', '`')
        break
      case 'math':
        this.wrapSelection(view, '$', '$')
        break
      case 'comment':
        this.wrapSelection(view, '<!-- ', ' -->')
        break
      case 'highlight':
        this.wrapSelection(view, '<mark class="hl">', '</mark>')
        break
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        this.applyHeading(view, Number(act[1]))
        break
      case 'quote':
        this.toggleLinePrefix(view, '> ')
        break
      case 'ul':
        this.toggleLinePrefix(view, '- ')
        break
      case 'ol':
        this.toggleLinePrefix(view, '1. ')
        break
      case 'codeblock':
        this.insertFence(view)
        break
      case 'mathblock':
        this.wrapMathBlock(view)
        break
      case 'footnote':
        this.insertFootnote(view)
        break
      case 'mark':
        this.wrapSelection(view, '<mark>', '</mark>')
        break
      case 'table':
        this.insertAtCursor(view, '| 列1 | 列2 |\n| --- | --- |\n|  |  |')
        break
      case 'hr':
        this.insertAtCursor(view, '\n---\n')
        break
      case 'copy':
        await this.copySelection(view)
        break
      case 'cut':
        await this.cutSelection(view)
        break
      case 'paste':
      case 'paste-plain':
        await this.pasteFromClipboard(view)
        break
      case 'select-all':
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
        break
    }
    view.focus()
  }

  /** 点击链接处理：https 等外部 → 系统浏览器（宿主 windowOpenHandler 已接 https: → shell.openExternal）；内部笔记路径 → 打开笔记 */
  private handleLinkClick(href: string): void {
    const url = href.trim()
    if (!url || url.startsWith('#')) return
    if (/^(https?:|mailto:|file:)/i.test(url)) {
      window.open(url, '_blank', 'noopener')
      return
    }
    void this.openNote(normalizePath(url))
  }

  /** 光标处插入（替换选区；无选区则插在光标处），光标移到插入内容末尾 */
  private insertAtCursor(view: EditorView, text: string): void {
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
  }

  /** 环绕选区（`**`/`*`/`~~`/`` ` `` 等）；无选区则插入一对标记、光标居中 */
  private wrapSelection(view: EditorView, before: string, after: string): void {
    const { from, to } = view.state.selection.main
    const sel = view.state.sliceDoc(from, to)
    if (sel) {
      view.dispatch({
        changes: { from, to, insert: before + sel + after },
        selection: { anchor: from + before.length, head: from + before.length + sel.length },
      })
    } else {
      view.dispatch({ changes: { from, to, insert: before + after }, selection: { anchor: from + before.length } })
    }
  }

  /** 行前缀切换（引用/列表）：选中范围覆盖的所有行加前缀，已全部有则移除 */
  private toggleLinePrefix(view: EditorView, prefix: string): void {
    const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const { from, to } = view.state.selection.main
    const start = view.state.doc.lineAt(from)
    const end = view.state.doc.lineAt(to)
    const lines: Array<{ no: number; has: boolean }> = []
    for (let l = start.number; l <= end.number; l++) lines.push({ no: l, has: re.test(view.state.doc.line(l).text) })
    const all = lines.every((x) => x.has)
    const changes = lines.map((x) => {
      const line = view.state.doc.line(x.no)
      return { from: line.from, to: line.to, insert: all ? line.text.replace(re, '') : x.has ? line.text : prefix + line.text }
    })
    view.dispatch({ changes })
  }

  /** 标题级别：设为指定级别；已是该级别则还原为正文 */
  private applyHeading(view: EditorView, level: number): void {
    const prefix = '#'.repeat(level) + ' '
    const re = /^#{1,6}\s*/
    const { from, to } = view.state.selection.main
    const start = view.state.doc.lineAt(from)
    const end = view.state.doc.lineAt(to)
    const changes: Array<{ from: number; to: number; insert: string }> = []
    for (let l = start.number; l <= end.number; l++) {
      const line = view.state.doc.line(l)
      changes.push({ from: line.from, to: line.to, insert: line.text.replace(re, (m) => (m === prefix ? '' : prefix)) })
    }
    view.dispatch({ changes })
  }

  /** 围栏代码块：选区内容包进 ```，无选区插入空代码块 */
  private insertFence(view: EditorView): void {
    const { from, to } = view.state.selection.main
    const text = view.state.sliceDoc(from, to)
    const insert = text ? '```\n' + text + '\n```' : '```\n\n```'
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
  }

  /** 数学块：选区内容包进 $$...$$，无选区插入空数学块 */
  private wrapMathBlock(view: EditorView): void {
    const { from, to } = view.state.selection.main
    const text = view.state.sliceDoc(from, to)
    const insert = text ? '$$\n' + text + '\n$$' : '$$\n\n$$'
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
  }

  /** 脚注：光标处插入 `[^N]` 引用，并在文末追加 `[^N]: 脚注内容` 定义（N 取文档现有最大脚注号 +1） */
  private insertFootnote(view: EditorView): void {
    const doc = view.state.doc.toString()
    let max = 0
    for (const m of doc.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]))
    const n = max + 1
    const ref = `[^${n}]`
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: [
        { from, to, insert: ref },
        { from: view.state.doc.length, to: view.state.doc.length, insert: `\n\n[^${n}]: 脚注内容` },
      ],
      selection: { anchor: from + ref.length },
    })
  }

  /** 剪贴板写入降级：navigator.clipboard 失败时用临时 textarea + execCommand('copy')（Electron/受限上下文兜底） */
  private async clipboardWrite(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      /* 走降级 */
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* 忽略 */
    }
    ta.remove()
  }

  private async copySelection(view: EditorView): Promise<void> {
    const text = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
    if (!text) return
    await this.clipboardWrite(text)
  }

  private async cutSelection(view: EditorView): Promise<void> {
    const { from, to } = view.state.selection.main
    const text = view.state.sliceDoc(from, to)
    if (!text) return
    await this.clipboardWrite(text)
    view.dispatch({ changes: { from, to, insert: '' } })
  }

  /** 粘贴（CM 默认以纯文本插入，粘贴与纯文本粘贴同行为） */
  private async pasteFromClipboard(view: EditorView): Promise<void> {
    try {
      const text = await navigator.clipboard.readText()
      if (text == null) return
      const { from, to } = view.state.selection.main
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    } catch {
      console.error('[notes] 剪贴板读取失败（可能无权限）')
    }
  }

  /** 收集已加载目录下的全部笔记（供"新增笔记链接"选择） */
  private collectNotes(): Array<{ path: string; title: string }> {
    const out: Array<{ path: string; title: string }> = []
    const walk = (dir: string): void => {
      for (const x of this.getSorted(dir)) {
        if (x.isDirectory) {
          if (this.tree.has(x.path)) walk(x.path)
        } else if (x.path.toLowerCase().endsWith('.md')) {
          out.push({ path: x.path, title: x.path.split('/').pop()!.replace(/\.md$/i, '') })
        }
      }
    }
    walk(ROOT)
    return out
  }

  /** 选择笔记弹窗：可搜索的笔记列表（已加载目录内），点条目/回车选择 */
  private openNoteLinkDialog(): Promise<string | null> {
    return new Promise((resolve) => {
      const notes = this.collectNotes()
      this.dialog = { title: '选择笔记', mode: 'link', resolve: (v) => resolve(typeof v === 'string' ? v : null), folderValue: '' }
      const ov = mustQuery<HTMLElement>(this.sr, '[data-overlay]')
      mustQuery<HTMLElement>(this.sr, '[data-modal-title]').textContent = '选择笔记'
      mustQuery<HTMLElement>(this.sr, '[data-modal-message]').hidden = true
      mustQuery<HTMLSelectElement>(this.sr, '[data-modal-select]').hidden = true
      const input = mustQuery<HTMLInputElement>(this.sr, '[data-modal-input]')
      input.hidden = false
      input.value = ''
      input.placeholder = '搜索笔记…（Enter 选首个）'
      input.focus()
      const list = mustQuery<HTMLElement>(this.sr, '[data-modal-folderlist]')
      list.hidden = false
      const render = (q: string): void => {
        const lower = q.trim().toLowerCase()
        const items = lower
          ? notes.filter((n) => n.title.toLowerCase().includes(lower) || n.path.toLowerCase().includes(lower))
          : notes
        list.innerHTML = items.length
          ? items
              .slice(0, 300)
              .map((n) => `<div class="folder-opt" data-note-opt="${escapeAttr(n.path)}" title="${escapeAttr(n.path)}">${escapeHtml(n.title)}</div>`)
              .join('')
          : '<div class="nav-empty">没有匹配的笔记。</div>'
      }
      render('')
      const close = (value: string | null): void => {
        input.removeEventListener('input', onInput)
        input.removeEventListener('keydown', onKey)
        list.removeEventListener('click', onClick)
        this.dialog = null
        ov.classList.remove('show')
        resolve(value)
      }
      const onInput = (): void => render(input.value)
      const onClick = (e: Event): void => {
        const item = targetClosest<HTMLElement>(e, '[data-note-opt]')
        if (!item) return
        close(item.dataset.noteOpt ?? null)
      }
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Enter') {
          const first = list.querySelector<HTMLElement>('[data-note-opt]')
          if (first) close(first.dataset.noteOpt ?? null)
        } else if (e.key === 'Escape') {
          close(null)
        }
      }
      input.addEventListener('input', onInput)
      input.addEventListener('keydown', onKey)
      list.addEventListener('click', onClick)
      ov.classList.add('show')
    })
  }

  async ctxAction(act: CtxAction, path: string, _kind: string): Promise<void> {
    // 多选：作用于右键时整个选中集；单选：[path]
    const paths = this.context?.paths && this.context.paths.length ? this.context.paths : [path]
    if (act === 'delete') {
      const multi = paths.length > 1
      const display = path.split('/').pop()!.replace(/\.md$/, '')
      const ok = await this.openConfirmDialog(
        '删除',
        multi ? `确定删除选中的 ${paths.length} 项？此操作不可恢复。` : `确定删除「${display}」？此操作不可恢复。`,
      )
      if (!ok) return
      await this.saveAll() // 先全部落盘，避免删除后防抖写回
      // 子路径去重：选中含父子关系时只删父（路径排序父在前）
      const sorted = [...paths].sort()
      const toDelete = sorted.filter((p, i) => !sorted.slice(0, i).some((q) => p.startsWith(q + '/')))
      for (const p of toDelete) {
        try {
          await window.api.pluginFiles.remove(PLUGIN_ID, p)
        } catch (err) {
          console.error('[notes] 删除失败', p, err)
          continue
        }
        this.search.remove(p) // 索引同步（含后代）
        // 关闭所有打开该路径/其后代的面板（discard 防写回）
        for (const [id, rec] of [...this.panes]) {
          if (rec.path && (rec.path === p || rec.path.startsWith(p + '/'))) {
            await this.closePane(id, { discard: true })
          }
        }
        // 清理展开状态 / 选中残留
        for (const x of [...this.expanded]) if (x === p || x.startsWith(p + '/')) this.expanded.delete(x)
        if (this.selectedItem === p || (this.selectedItem && this.selectedItem.startsWith(p + '/'))) this.selectedItem = ROOT
        this.multiSel.delete(p)
      }
      if (this.panes.size === 0) this.resetEditor()
      // 刷新涉及的父目录，避免树节点残留
      const parents = new Set(toDelete.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ROOT)))
      for (const parent of parents) await this.loadDir(parent)
      this.renderTreeWindow()
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
      const multi = paths.length > 1
      const display = path.split('/').pop()!.replace(/\.md$/, '')
      // 排除全部选中项及其后代（多选时也不能移入自身子树）
      const excluded = (f: string) => paths.some((p) => f === p || f.startsWith(p + '/'))
      const target = await this.openFolderDialog(multi ? `移动选中的 ${paths.length} 项到` : `移动「${display}」到`, folders, excluded)
      if (target == null) return
      for (const p of paths) {
        const newPath = (target ? target + '/' : '') + p.split('/').pop()!
        if (newPath === p) continue
        try {
          await window.api.pluginFiles.move(PLUGIN_ID, p, newPath)
          this.search.rename(p, newPath) // 索引同步（含后代）
          // 打开该路径/后代的面板：重写路径前缀并刷新标题
          for (const rec of this.panes.values()) {
            if (rec.path && (rec.path === p || rec.path.startsWith(p + '/'))) {
              rec.path = newPath + rec.path.slice(p.length)
              this.updatePaneTitle(rec.id)
            }
          }
          if (this.selectedItem === p || (this.selectedItem && this.selectedItem.startsWith(p + '/'))) {
            this.selectedItem = newPath + this.selectedItem.slice(p.length)
          }
          if (this.multiSel.has(p)) {
            this.multiSel.delete(p)
            this.multiSel.add(newPath)
          }
        } catch (err) {
          console.error('[notes] 移动失败', p, err)
        }
      }
      if (target) {
        this.expanded.add(target) // 移动后自动展开目标文件夹，让文件立即可见
      }
      await this.loadDir(ROOT)
      await this.loadDir(target)
      this.renderTreeWindow()
    }
  }

  async renameEntry(path: string): Promise<void> {
    await this.saveAll()
    const name = path.split('/').pop()!
    const isMd = name.endsWith('.md')
    const value = await this.openInputDialog('重命名', '新名称', isMd ? name.slice(0, -3) : name)
    if (value == null || !value) return
    const bare = isMd ? value.replace(/\.md$/i, '') : value
    if (bare === name.replace(/\.md$/, '')) return
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT
    const newPath = (parent ? parent + '/' : '') + bare + (isMd ? '.md' : '')
    try {
      await window.api.pluginFiles.move(PLUGIN_ID, path, newPath)
      this.search.rename(path, newPath) // 索引同步（含后代）
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

  async copyEntry(path: string): Promise<void> {
    const name = path.split('/').pop()!
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

  resetEditor(): void {
    for (const rec of this.panes.values()) {
      clearTimer(rec.saveTimer)
      // 脏检查：未修改不写盘（fire-and-forget）
      if (rec.path && rec.editor && rec.lastSavedText !== rec.editor.state.doc.toString()) {
        window.api.pluginFiles.write(PLUGIN_ID, rec.path, rec.editor.state.doc.toString()).catch(() => {})
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
    this.multiSel.clear()
    this.selAnchor = null
    clearTimer(this.previewTimer)
    this.updateHead() // 回全局占位（含重建）
    const editor = mustQuery<HTMLElement>(this.sr, '.editor')
    editor.classList.remove('mode-normal', 'mode-source', 'mode-preview', 'mode-split', 'mode-split-v')
    editor.classList.add('mode-normal')
    this.renderMoreMenu()
  }

  async collectAllFolders(): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
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
  openInputDialog(title: string, placeholder: string, value: string): Promise<string | null> {
    return new Promise((resolve) => {
      // 包装：dialog.resolve 按接口签名可传 boolean，这里收窄为 string | null（input 弹层只会产出字符串/取消）
      this.dialog = { title, mode: 'input', resolve: (v) => resolve(typeof v === 'string' ? v : null) }
      const ov = mustQuery<HTMLElement>(this.sr, '[data-overlay]')
      mustQuery<HTMLElement>(this.sr, '[data-modal-title]').textContent = title
      mustQuery<HTMLElement>(this.sr, '[data-modal-message]').hidden = true
      const input = mustQuery<HTMLInputElement>(this.sr, '[data-modal-input]')
      input.hidden = false
      input.placeholder = placeholder
      input.value = value
      input.focus()
      input.select()
      mustQuery<HTMLSelectElement>(this.sr, '[data-modal-select]').hidden = true
      mustQuery<HTMLElement>(this.sr, '[data-modal-folderlist]').hidden = true
      const ok = mustQuery<HTMLButtonElement>(this.sr, '[data-modal-ok]')
      ok.classList.remove('danger')
      ok.textContent = '确定'
      ov.classList.add('show')
    })
  }

  openFolderDialog(title: string, folders: string[], exclude: (f: string) => boolean): Promise<string | null> {
    return new Promise((resolve) => {
      // 包装：见 openInputDialog
      this.dialog = { title, mode: 'folder', resolve: (v) => resolve(typeof v === 'string' ? v : null), folderValue: '' }
      const ov = mustQuery<HTMLElement>(this.sr, '[data-overlay]')
      mustQuery<HTMLElement>(this.sr, '[data-modal-title]').textContent = title
      mustQuery<HTMLElement>(this.sr, '[data-modal-message]').hidden = true
      mustQuery<HTMLInputElement>(this.sr, '[data-modal-input]').hidden = true
      mustQuery<HTMLElement>(this.sr, '[data-modal-folderlist]').hidden = true
      mustQuery<HTMLSelectElement>(this.sr, '[data-modal-select]').hidden = true
      const list = mustQuery<HTMLElement>(this.sr, '[data-modal-folderlist]')
      const depth = (f: string | null) => (f ? f.split('/').length : 0)
      const shortName = (f: string | null) => (f ? f.split('/').pop() : '根目录')
      list.innerHTML =
        '<div class="folder-opt on" data-folder-opt="">根目录</div>' +
        folders
          .filter((f) => !exclude(f))
          .map((f) => `<div class="folder-opt" data-folder-opt="${escapeAttr(f)}" style="padding-left:${depth(f) * 14 + 8}px">${escapeHtml(shortName(f))}</div>`)
          .join('')
      list.hidden = false
      const ok = mustQuery<HTMLButtonElement>(this.sr, '[data-modal-ok]')
      ok.classList.remove('danger')
      ok.textContent = '确定'
      ov.classList.add('show')
    })
  }

  openConfirmDialog(title: string, message: string): Promise<boolean | null> {
    return new Promise((resolve) => {
      // 包装：confirm 弹层只会产出 true/取消(null)
      this.dialog = { title, mode: 'confirm', resolve: (v) => resolve(typeof v === 'boolean' ? v : null) }
      const ov = mustQuery<HTMLElement>(this.sr, '[data-overlay]')
      mustQuery<HTMLElement>(this.sr, '[data-modal-title]').textContent = title
      const msg = mustQuery<HTMLElement>(this.sr, '[data-modal-message]')
      msg.textContent = message
      msg.hidden = false
      mustQuery<HTMLInputElement>(this.sr, '[data-modal-input]').hidden = true
      mustQuery<HTMLSelectElement>(this.sr, '[data-modal-select]').hidden = true
      mustQuery<HTMLElement>(this.sr, '[data-modal-folderlist]').hidden = true
      const ok = mustQuery<HTMLButtonElement>(this.sr, '[data-modal-ok]')
      ok.classList.add('danger')
      ok.textContent = '删除'
      ok.focus()
      ov.classList.add('show')
    })
  }

  confirmDialog(): void {
    if (!this.dialog) return
    const { resolve } = this.dialog
    const input = mustQuery<HTMLInputElement>(this.sr, '[data-modal-input]')
    const sel = mustQuery<HTMLSelectElement>(this.sr, '[data-modal-select]')
    const value: string | boolean | null =
      this.dialog.mode === 'confirm'
        ? true
        : this.dialog.mode === 'folder' || this.dialog.mode === 'link'
          ? (this.dialog.folderValue ?? '')
          : input.hidden
            ? sel.value
            : input.value.trim()
    this.dialog = null
    mustQuery<HTMLElement>(this.sr, '[data-overlay]').classList.remove('show')
    resolve(value)
  }

  closeDialog(): void {
    if (!this.dialog) return
    const { resolve } = this.dialog
    this.dialog = null
    mustQuery<HTMLElement>(this.sr, '[data-overlay]').classList.remove('show')
    resolve(null)
  }
}
