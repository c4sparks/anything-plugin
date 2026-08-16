import { pinyin } from 'pinyin-pro'

/**
 * 插件搜索匹配（增强版）：
 * - 多关键词空格分词：`demo 时钟` → 两个词都命中才算（AND）
 * - 拼音：中文名可打全拼（`shizhong` → 时钟）或首字母（`sz` → 时钟）
 * - 子串：原文大小写不敏感包含（保留基础能力）
 *
 * 例：`时钟` 命中 `时钟`/`shizhong`/`sz`；`demo host` 命中 demo-host。
 */
const pinyinCache = new Map<string, { full: string; initials: string }>()

function toPinyin(text: string): { full: string; initials: string } {
  const hit = pinyinCache.get(text)
  if (hit) return hit
  const result = {
    full: pinyin(text, { toneType: 'none' }).replace(/\s+/g, '').toLowerCase(),
    initials: pinyin(text, { pattern: 'first', toneType: 'none' })
      .replace(/\s+/g, '')
      .toLowerCase(),
  }
  pinyinCache.set(text, result)
  return result
}

export interface Searchable {
  name: string
  id: string
  description?: string
}

/** 是否匹配：每个关键词（空格分词）都在 原文/全拼/首字母 中出现 */
export function pluginMatches(p: Searchable, query: string): boolean {
  const kws = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!kws.length) return true
  const haystack = [p.name, p.id, p.description ?? ''].join(' ').toLowerCase()
  const py = toPinyin(haystack)
  return kws.every((kw) => haystack.includes(kw) || py.full.includes(kw) || py.initials.includes(kw))
}

/** 命中第一个出现的关键词，供高亮（多关键词只高亮最先命中的那个） */
export function firstHitKeyword(text: string, query: string): string | null {
  if (!query || !text) return null
  const lower = text.toLowerCase()
  const kw = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .find((k) => k && lower.includes(k))
  return kw ?? null
}
