// 预览渲染管线（P2 语法扩展）：marked + 自定义扩展，产物经 DOMPurify 后再注入预览区。
// 覆盖范围：
// - 基础 + GFM（marked 内置）：标题/粗体/斜体/引用/列表/代码/分隔线/链接/图片/表格/任务列表/删除线/自动链接
// - 代码块语法高亮：highlight.js（lib/common 常见语言）
// - 脚注：`[^id]: 定义` + 行内引用 `[^id]`（解析后统一追加脚注区）
// - 标题编号：heading renderer 自动加 id（slugify + 去重）
// - 定义列表：`术语\n: 定义`
// - 数学公式：`$...$` 行内 / `$$...$$` 块级，KaTeX 渲染（字体缺省时回退系统字体）
// - Mermaid：```mermaid 保留源码块，hydrateMermaid() 运行时懒加载渲染（CDN 不可达则显示源码）
import { marked, type Token, type Tokens } from 'marked'
import hljs from 'highlight.js/lib/common'
import katex from 'katex'
import { escapeHtml } from './util'

/** 本解析周期的脚注定义（renderMarkdown 每次解析前重置；marked 解析为同步，多面板无并发） */
let fnDefs = new Map<string, string>()
/** 标题 id 去重计数（同一 slug 追加 -2/-3…） */
let headingIds = new Map<string, number>()

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

function uniqueId(base: string): string {
  const n = headingIds.get(base) ?? 0
  headingIds.set(base, n + 1)
  return n === 0 ? base : `${base}-${n + 1}`
}

marked.use({
  gfm: true,
  renderer: {
    // 标题：自动加 id（供大纲锚点/页内跳转）
    heading(token: Tokens.Heading) {
      const text = this.parser.parseInline(token.tokens)
      const id = uniqueId(slugify(token.text))
      return `<h${token.depth} id="${id}">${text}</h${token.depth}>`
    },
    // 代码块：mermaid 保留源码块待懒加载渲染；其余按语言高亮（未知语言退纯文本）
    code(token: Tokens.Code) {
      const lang = (token.lang ?? '').toLowerCase()
      if (lang === 'mermaid') {
        return `<pre class="mermaid-src"><code class="language-mermaid">${escapeHtml(token.text)}</code></pre>`
      }
      if (lang && hljs.getLanguage(lang)) {
        try {
          const hl = hljs.highlight(token.text, { language: lang })
          return `<pre><code class="hljs language-${lang}">${hl.value}</code></pre>`
        } catch {
          /* 高亮失败退回纯文本 */
        }
      }
      return `<pre><code class="hljs${lang ? ' language-' + lang : ''}">${escapeHtml(token.text)}</code></pre>`
    },
  },
  extensions: [
    // 脚注定义块 `[^id]: 定义`（就地不渲染，末尾统一追加脚注区）
    {
      name: 'footnoteDef',
      level: 'block',
      start(src: string) {
        return /^\[\^[^\]]+\]:/.test(src) ? 0 : src.length
      },
      tokenizer(src: string) {
        const match = /^\[\^([^\]]+)\]:[ \t]*([\s\S]*?)(?=\n\s*\n|$|\n\[\^)/.exec(src)
        if (!match) return undefined
        fnDefs.set(match[1], match[2].trim())
        return { type: 'footnoteDef', raw: match[0], id: match[1] }
      },
      renderer() {
        return ''
      },
    },
    // 脚注引用 `[^id]`
    {
      name: 'footnoteRef',
      level: 'inline',
      start(src: string) {
        return src.indexOf('[^')
      },
      tokenizer(src: string) {
        const match = /^\[\^([^\]]+)\]/.exec(src)
        if (!match) return undefined
        return { type: 'footnoteRef', raw: match[0], id: match[1] }
      },
      renderer(token: Tokens.Generic) {
        const id = (token as { id?: string }).id ?? ''
        return `<sup class="fn-ref" id="fnref-${id}"><a href="#fn-${id}">[${id}]</a></sup>`
      },
    },
    // 定义列表 `术语\n: 定义`（可多术语/多定义）
    {
      name: 'deflist',
      level: 'block',
      start(src: string) {
        // 返回「术语行起点」索引（相对 src.slice(1)），限制前一段落吞并紧跟的术语/定义行
        const m = /\n[^\n:]+\n:/.exec(src)
        if (m) return m.index // 术语行前一个 \n 的位置 → 段落到此为止
        return /^[^\n:]+\n:/.test(src) ? 0 : src.length
      },
      tokenizer(src: string) {
        const match = /^(?:(?:[^\n]+\n)(?::[^\n]*\n?)+)+/.exec(src)
        if (!match) return undefined
        const raw: Array<{ term: string; defs: string[] }> = []
        let cur: { term: string; defs: string[] } | null = null
        for (const line of match[0].split('\n')) {
          if (!line) continue
          if (line.startsWith(':')) {
            if (cur) cur.defs.push(line.slice(1).trim())
          } else {
            cur = { term: line.trim(), defs: [] }
            raw.push(cur)
          }
        }
        return {
          type: 'deflist',
          raw: match[0],
          items: raw.map((it) => ({
            termTokens: this.lexer.inlineTokens(it.term),
            defsTokens: it.defs.map((d) => this.lexer.inlineTokens(d)),
          })),
        }
      },
      renderer(token: Tokens.Generic) {
        const items = (token as { items?: Array<{ termTokens: Token[]; defsTokens: Token[][] }> }).items ?? []
        let html = '<dl>'
        for (const it of items) {
          html += `<dt>${this.parser.parseInline(it.termTokens)}</dt>`
          for (const dt of it.defsTokens) html += `<dd>${this.parser.parseInline(dt)}</dd>`
        }
        return html + '</dl>'
      },
    },
    // 块级数学 `$$...$$`
    {
      name: 'mathBlock',
      level: 'block',
      start(src: string) {
        return src.startsWith('$$') ? 0 : src.length
      },
      tokenizer(src: string) {
        const match = /^\$\$([\s\S]+?)\$\$/.exec(src)
        if (!match) return undefined
        return { type: 'mathBlock', raw: match[0], text: match[1].trim() }
      },
      renderer(token: Tokens.Generic) {
        const text = (token as { text?: string }).text ?? ''
        return `<div class="math-block">${katex.renderToString(text, { throwOnError: false, displayMode: true })}</div>`
      },
    },
    // 行内数学 `$...$`
    {
      name: 'mathInline',
      level: 'inline',
      start(src: string) {
        return src.indexOf('$')
      },
      tokenizer(src: string) {
        const match = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/.exec(src)
        if (!match) return undefined
        return { type: 'mathInline', raw: match[0], text: match[1] }
      },
      renderer(token: Tokens.Generic) {
        const text = (token as { text?: string }).text ?? ''
        return `<span class="math-inline">${katex.renderToString(text, { throwOnError: false, displayMode: false })}</span>`
      },
    },
  ],
})

/** 渲染一篇文章：重置扩展状态 → marked 解析 → 追加脚注区 */
export function renderMarkdown(src: string): string {
  fnDefs = new Map()
  headingIds = new Map()
  let html = marked.parse(src, { async: false }) as string
  if (fnDefs.size) {
    const items: string[] = []
    for (const [id, text] of fnDefs) {
      items.push(`<li id="fn-${id}">${marked.parseInline(text)} <a class="fn-back" href="#fnref-${id}" aria-label="返回">↩</a></li>`)
    }
    html += `\n<section class="footnotes"><hr><ol>${items.join('')}</ol></section>`
  }
  return html
}

/** Mermaid 懒加载渲染：CDN 可达时把 ```mermaid 源码块替换为渲染图；失败保留源码（优雅降级） */
export async function hydrateMermaid(preview: HTMLElement): Promise<void> {
  const blocks = preview.querySelectorAll<HTMLElement>('pre.mermaid-src')
  if (!blocks.length) return
  const url = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
  try {
    const mod = await import(url)
    const mermaid = (mod.default ?? mod) as { initialize(o: object): void; run(o: object): Promise<void> }
    mermaid.initialize({ startOnLoad: false, theme: 'default' })
    for (const pre of [...blocks]) {
      const code = pre.querySelector('code')?.textContent ?? ''
      const div = document.createElement('div')
      div.className = 'mermaid'
      div.textContent = code
      pre.replaceWith(div)
    }
    await mermaid.run({ nodes: [...preview.querySelectorAll<HTMLElement>('.mermaid')] })
  } catch {
    /* CDN 不可达：保留源码块 */
  }
}
