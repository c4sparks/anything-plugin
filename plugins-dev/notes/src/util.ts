// 纯函数工具（无状态，可独立测试）
import type { SplitTree } from './types'

/** HTML 转义映射（用于插值进 innerHTML 的文本） */
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** HTML 转义（用于插值进 innerHTML 的文本） */
export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c])
}

/** 属性值转义：HTML 转义基础上再处理反引号（用于属性插值） */
export function escapeAttr(s: unknown): string {
  return escapeHtml(s).replace(/`/g, '&#96;')
}

/** 搜索词高亮：返回已转义 HTML，匹配段包 <mark> */
export function highlightMatch(text: string, q: string): string {
  if (!q) return escapeHtml(text)
  const lower = text.toLowerCase()
  const parts: string[] = []
  let i = 0
  let idx = lower.indexOf(q)
  while (idx !== -1) {
    if (idx > i) parts.push(escapeHtml(text.slice(i, idx)))
    parts.push(`<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>`)
    i = idx + q.length
    idx = lower.indexOf(q, i)
  }
  if (i < text.length) parts.push(escapeHtml(text.slice(i)))
  return parts.join('')
}

/** 从事件目标向上找选择器命中元素（e.target 可能是文本节点/非 Element） */
export function targetClosest<T extends Element>(e: Event, sel: string): T | null {
  return e.target instanceof Element ? e.target.closest<T>(sel) : null
}

/** 必选元素查询：模板保证存在，缺失即抛错（vs 到处 `!` 断言）。默认返回 HTMLElement——TS 6 的 lib.dom 里 ElementEventMap 只剩 fullscreen 事件，返回 Element 会让事件回调参数退化成 Event */
export function mustQuery<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector(sel)
  if (!el) throw new Error(`[notes] 缺少元素: ${sel}`)
  return el as T
}

/** 安全清理定时器（字段类型为 number | null，DOM clearTimeout 只收 number | undefined） */
export function clearTimer(t: ReturnType<typeof setTimeout> | null | undefined): void {
  if (t != null) clearTimeout(t)
}

/** 分屏树工具：摘除含 cardId 的叶子并就地折叠（split 只剩 1 孩子 → 用孩子替换自己） */
export function removeLeaf(node: SplitTree | null, cardId: string): SplitTree | null {
  if (!node) return null
  if (node.type === 'leaf') return node.cardId === cardId ? null : node
  const a = removeLeaf(node.children[0], cardId)
  const b = removeLeaf(node.children[1], cardId)
  if (a === null && b === null) return null
  if (a === null) return b
  if (b === null) return a
  return { type: 'split', dir: node.dir, children: [a, b] }
}

/** 路径归一化：主进程契约返回正斜杠，防御性再归一化一次，避免 Windows 反斜杠破坏 `/` 路径逻辑 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}
