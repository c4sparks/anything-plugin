// NotesApp 主类：笔记知识库插件（个人知识库）——左右布局 + 文件夹/文件树 + 排序 + 展开收起 + 右键菜单
// 多开面板模型：panes = 所有打开的笔记（标签）；分屏按「卡片」分组，每张卡片自带独立标签栏。
// 数据：window.api.pluginFiles（契约 docs/插件契约.md §6），存 userData/plugin-data/notes/files/。
import { Compartment, EditorState, type Transaction } from '@codemirror/state'
import { placeholder } from '@codemirror/view'
import { EditorView, basicSetup } from 'codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

import { editorTheme, Sync } from './editor'
import { livePreviewExt } from './live-preview'
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
  private dialog: DialogState | null = null // {title, mode:'input'|'folder'|'confirm', resolve, message?}

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
    this.renderSplit() // 初始无面板：显示全局占位
    this.updateHead()
    void this.loadDir(ROOT)
  }

  disconnectedCallback(): void {
    clearTimer(this.previewTimer)
    for (const rec of this.panes.values()) {
      clearTimer(rec.saveTimer)
      if (rec.path && rec.editor) {
        const content = rec.editor.state.doc.toString() // 先捕获内容再写（fire-and-forget）
        window.api.pluginFiles.write(PLUGIN_ID, rec.path, content).catch(() => {})
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
    // 卡片内事件委托：标签切换/关闭、新建、更多、点击聚焦、拖拽（标签栏=多开，内容=插链接）、导航（搜索/清除/大纲）
    splitRoot.addEventListener('click', (e) => {
      const card = targetClosest<HTMLElement>(e, '[data-card-id]')
      if (!card) return
      const cardId = card.dataset.cardId
      const clearBtn = targetClosest<HTMLElement>(e, '.card-nav-clear')
      if (clearBtn) {
        e.stopPropagation()
        const c = cardId ? this.cards.get(cardId) : undefined
        if (c) {
          c.navQuery = ''
          this.applyNavHighlight(c)
          this.renderOutline(c)
          const input = cardId ? this.sr.querySelector<HTMLInputElement>(`[data-card-nav-search="${cardId}"]`) : null
          if (input) input.value = ''
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
    // 卡片导航搜索输入：实时过滤该卡片的预览高亮 + 大纲
    splitRoot.addEventListener('input', (e) => {
      const search = targetClosest<HTMLInputElement>(e, '[data-card-nav-search]')
      if (!search) return
      const c = search.dataset.cardNavSearch ? this.cards.get(search.dataset.cardNavSearch) : undefined
      if (!c) return
      c.navQuery = search.value.trim().toLowerCase()
      this.applyNavHighlight(c)
      this.renderOutline(c)
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
        this.selectFolder(ROOT) // 点击文件树空白处 = 回到根
        return
      }
      const path = row.dataset.path
      const kind = row.dataset.kind
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
      if (path) this.showContext(e, path, row.dataset.kind ?? 'file')
    })
    mustQuery(root, '[data-sort-menu]').addEventListener('click', (e) => {
      const item = targetClosest<HTMLElement>(e, '[data-opt]')
      if (!item) return
      const opt = SORT_OPTIONS[Number(item.dataset.opt)]
      if (!opt) return
      this.sortKey = opt.key
      this.sortDir = opt.dir
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
      this.renderTree()
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

  renderTree(): void {
    const tree = mustQuery<HTMLElement>(this.sr, '[data-tree]')
    const q = this.filter
    const lines: string[] = []
    const fileMatches = (x: FileEntry) => x.name.toLowerCase().includes(q)
    const dirHasMatch = (path: string): boolean => {
      const entries = this.sortEntries(this.tree.get(path) ?? [])
      return entries.some((x) => (x.isDirectory ? dirHasMatch(x.path) : fileMatches(x)))
    }
    const walk = (dir: string, depth: number): void => {
      const entries = this.sortEntries(this.tree.get(dir) ?? [])
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
          `<div class="${cls.join(' ')}" style="${indent}" data-path="${escapeAttr(x.path)}" data-kind="${isFolder ? 'folder' : 'file'}" title="${escapeAttr(x.path)}" ${isFolder ? '' : 'draggable="true"'}>
            <span class="caret">${caret}</span>
            <span class="ic">${isFolder ? ICON_FOLDER_SM : ICON_DOC_SM}</span>
            <span class="nm">${highlightMatch(x.name.replace(/\.md$/, ''), q)}</span>
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
    const cardEl = rec.cardId ? this.sr.querySelector<HTMLElement>(`[data-card-id="${rec.cardId}"]`) : null
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
    this.updateHead()
    this.renderSplit()
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
    if (card.navOpen) this.renderPreview(card.activePaneId)
    this.renderSplit()
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
    const raw = content ? (marked.parse(content, { async: false }) as string) : ''
    const safe = content ? DOMPurify.sanitize(raw) : ''
    preview.innerHTML = safe
    // 该卡片导航开着 → 应用该卡片自己的搜索高亮 + 重建大纲
    if (card && card.navOpen && target.id === card.activePaneId) {
      this.applyNavHighlight(card)
      this.renderOutline(card)
    }
  }

  /** 在指定卡片的预览上高亮该卡片的搜索词 */
  applyNavHighlight(card: CardRecord): void {
    const q = card.navQuery
    if (!q) return
    const target = card.activePaneId ? this.panes.get(card.activePaneId) : undefined
    if (!target) return
    const preview = this.sr.querySelector<HTMLElement>(`[data-card-id="${card.id}"] [data-preview]`)
    if (!preview) return
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT)
    const targets: Text[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeType !== Node.TEXT_NODE) continue
      if (node.parentElement?.closest('pre, code, script, style')) continue
      targets.push(node as Text)
    }
    for (const node of targets) {
      const text = node.textContent ?? ''
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
      this.renderSplit()
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
    this.renderSplit()
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
    this.renderSplit()
    await this.openInPane(tab.id, path)
  }

  // ---------- 多开拆分面板 ----------
  updatePaneTitle(_paneId: string): void {
    this.renderSplit() // 卡片标签/路径随重渲染刷新（重命名/移动/换笔记时）
  }

  /** 重渲染卡片（标签栏/路径栏都在卡片内） */
  updateHead(): void {
    this.renderSplit()
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
        `<div class="card-nav-toolbar"><input class="card-nav-search" data-card-nav-search="${card.id}" value="${escapeAttr(card.navQuery)}" placeholder="搜索…" spellcheck="false" /><button type="button" class="card-nav-clear" data-card-nav-clear="${card.id}" title="清除搜索" aria-label="清除搜索">×</button></div>` +
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
    const rec: PaneRecord = { id: 'pane-' + this.nextPaneId++, cardId: null, path: null, mode: 'normal', editor: null, saveTimer: null, liveCompartment: null, live: false }
    this.panes.set(rec.id, rec)
    return rec
  }

  /** 新建一张分屏卡片（含独立标签栏） */
  createCard(): CardRecord {
    const card: CardRecord = { id: 'card-' + this.nextCardId++, paneIds: [], activePaneId: null, navOpen: false, navQuery: '', outline: [] }
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
        await window.api.pluginFiles.write(PLUGIN_ID, rec.path, rec.editor.state.doc.toString())
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
    this.updateHead()
    this.renderSplit()
    this.renderTree()
    this.renderPreview(paneId)
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

  async savePane(paneId: string): Promise<void> {
    const rec = this.panes.get(paneId)
    if (!rec) return
    clearTimer(rec.saveTimer) // 取消防抖定时器：避免删除/切换后旧定时器把文件写回
    if (!rec.path || !rec.editor) return
    try {
      await window.api.pluginFiles.write(PLUGIN_ID, rec.path, rec.editor.state.doc.toString())
    } catch (err) {
      console.error('[notes] 保存失败', err)
    }
  }

  saveAll(): Promise<void[]> {
    return Promise.all([...this.panes.keys()].map((id) => this.savePane(id)))
  }

  /** 兼容旧调用点：保存激活面板 */
  saveCurrent(): Promise<void> {
    return this.activePaneId ? this.savePane(this.activePaneId) : Promise.resolve()
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
  showContext(e: MouseEvent, path: string, kind: string): void {
    this.context = { path, kind }
    const ctx = mustQuery<HTMLElement>(this.sr, '[data-ctx]')
    ctx.innerHTML = [
      { act: 'copy', label: '复制', icon: ICON_CTX_COPY },
      { act: 'move', label: '移动', icon: ICON_CTX_MOVE },
      { act: 'rename', label: '重命名', icon: ICON_CTX_RENAME },
      { act: 'delete', label: '删除', icon: ICON_CTX_DELETE },
    ]
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

  async ctxAction(act: CtxAction, path: string, _kind: string): Promise<void> {
    if (act === 'delete') {
      const display = path.split('/').pop()!.replace(/\.md$/, '')
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
      const display = path.split('/').pop()!.replace(/\.md$/, '')
      const target = await this.openFolderDialog(`移动「${display}」到`, folders, path)
      if (target == null) return
      const newPath = (target ? target + '/' : '') + path.split('/').pop()!
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
    clearTimer(this.previewTimer)
    this.renderSplit() // 回全局占位
    this.updateHead()
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

  openFolderDialog(title: string, folders: string[], excludePath: string): Promise<string | null> {
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
          .filter((f) => f !== excludePath && !(excludePath && f.startsWith(excludePath + '/')))
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
      this.dialog.mode === 'confirm' ? true : this.dialog.mode === 'folder' ? (this.dialog.folderValue ?? '') : input.hidden ? sel.value : input.value.trim()
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
