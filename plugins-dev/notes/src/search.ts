// 全文搜索索引：MiniSearch + CJK bigram 分词（中文无空格，默认分词搜不到）。
// 仅存内存（数万条 meta ~800KB，超 pluginData 512KB value 上限，重启后台重建）；
// 正文只索引 title + body 前 BODY_LIMIT 字；保存/删除/重命名增量同步。
import MiniSearch from 'minisearch'

export interface IndexDoc {
  path: string
  title: string
  name: string
  body: string
}

export interface SearchHit {
  path: string
  title: string
  name: string
}

/** 正文索引上限（字符） */
const BODY_LIMIT = 4000

/** CJK bigram 分词：中文段 [一-鿿]+ 滑窗产出 1-gram/2-gram，拉丁/数字按词 */
function tokenize(text: string): string[] {
  const out: string[] = []
  const latin = text.match(/[a-zA-Z0-9_]+/g)
  if (latin) out.push(...latin)
  const cjk = text.match(/[\u4e00-\u9fff]+/g)
  if (cjk) {
    for (const seg of cjk) {
      for (let i = 0; i < seg.length; i++) {
        out.push(seg[i])
        if (i + 1 < seg.length) out.push(seg.slice(i, i + 2))
      }
    }
  }
  return out
}

/** 标题提取：首个 `# ` 一级标题；无则用文件名 */
export function docTitle(path: string, content: string): string {
  const m = /^#\s+(.+)$/m.exec(content)
  return m ? m[1].trim() : path.split('/').pop()!.replace(/\.md$/i, '')
}

export class NoteIndex {
  private mini = new MiniSearch<IndexDoc>({
    idField: 'path',
    fields: ['title', 'name', 'path', 'body'],
    storeFields: ['path', 'title', 'name'],
    searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'OR' },
    tokenize,
  })
  /** path -> mtimeMs（增量索引判断；纯内存） */
  private meta = new Map<string, number>()
  /** 索引中待处理数量（后台建索引时 >0，用于 UI 角标） */
  pending = 0

  get size(): number {
    return this.meta.size
  }

  has(path: string): boolean {
    return this.meta.has(path)
  }

  mtime(path: string): number | undefined {
    return this.meta.get(path)
  }

  /** 写入/覆盖一条（同 id 先 discard 再 add，幂等；v7 discard 对不存在 id 抛错，需先 has 判断） */
  add(path: string, content: string, mtimeMs?: number): void {
    if (this.mini.has(path)) this.mini.discard(path)
    this.mini.add({
      path,
      title: docTitle(path, content),
      name: path.split('/').pop() ?? path,
      body: content.slice(0, BODY_LIMIT),
    })
    this.meta.set(path, mtimeMs ?? Date.now())
  }

  /** 内容/时间未变则跳过（增量入口：loadDir/open/save） */
  upsertIfChanged(path: string, content: string, mtimeMs?: number): boolean {
    const prev = this.meta.get(path)
    if (mtimeMs != null && prev === mtimeMs) return false
    this.add(path, content, mtimeMs)
    return true
  }

  /** 删除自身及其后代 */
  remove(path: string): void {
    for (const p of [...this.meta.keys()]) {
      if (p === path || p.startsWith(path + '/')) {
        this.mini.discard(p)
        this.meta.delete(p)
      }
    }
  }

  /** 重命名/移动：自身及其后代路径前缀替换（meta 保留原 mtime） */
  rename(oldPath: string, newPath: string): void {
    const hits: Array<{ p: string; doc: IndexDoc }> = []
    for (const p of this.meta.keys()) {
      if (p === oldPath || p.startsWith(oldPath + '/')) {
        const stored = this.mini.getStoredFields(p) as Partial<IndexDoc> | undefined
        if (stored) hits.push({ p, doc: { path: p, title: stored.title ?? p, name: stored.name ?? p, body: '' } })
      }
    }
    for (const { p, doc } of hits) {
      const np = newPath + p.slice(oldPath.length)
      const oldMtime = this.meta.get(p)
      this.mini.discard(p)
      this.meta.delete(p)
      this.mini.add({ ...doc, path: np, name: np.split('/').pop() ?? np })
      this.meta.set(np, oldMtime ?? Date.now()) // 保留原 mtime：ensureIndexed 可继续按 mtime 跳过
    }
  }

  /** 搜索（结果含 title/name/path，按相关度排序；v7 无 limit 选项，返回后切片） */
  search(q: string, limit = 100): SearchHit[] {
    const query = q.trim()
    if (!query) return []
    const res = this.mini.search(query)
    return res.slice(0, limit).map((r) => ({ path: r.path, title: r.title, name: r.name }))
  }
}
