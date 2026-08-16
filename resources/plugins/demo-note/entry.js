// 测试插件：可编辑便签（content 槽位）。无依赖、单文件、纯 ES Module 原生 Web Component。
// 数据：window.api.pluginData（userData/plugin-data/demo-note/data.json，契约 docs/插件契约.md §5）——
// 不随浏览器数据清理丢失、卸载插件保留；600ms 防抖保存；「复制 / 清空」；生命周期钩子 onMount/onUnmount。
const PLUGIN_ID = 'demo-note'
const DATA_KEY = 'text'

class DemoNote extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: 'open' })
    this.render()
    const ta = this.shadowRoot.querySelector('textarea')
    ta.addEventListener('input', () => this.onInput())
    this.shadowRoot
      .querySelector('[data-action="copy"]')
      .addEventListener('click', () => this.copy())
    this.shadowRoot
      .querySelector('[data-action="clear"]')
      .addEventListener('click', () => this.clear())
    void this.load()
  }

  disconnectedCallback() {
    clearTimeout(this.saveTimer)
  }

  onInput() {
    const ta = this.shadowRoot.querySelector('textarea')
    this.updateCounts()
    this.setStatus('编辑中…', 'editing')
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.save(), 600)
  }

  async load() {
    try {
      const stored = await window.api.pluginData.get(PLUGIN_ID, DATA_KEY)
      const ta = this.shadowRoot.querySelector('textarea')
      // 用户先输入时不覆盖（加载与输入竞态兜底）
      if (stored != null && !ta.value) {
        ta.value = stored
        this.updateCounts()
      }
      this.setStatus('已载入', 'saved')
    } catch {
      this.setStatus('数据读取失败', 'editing')
    }
  }

  async save() {
    const ta = this.shadowRoot.querySelector('textarea')
    try {
      await window.api.pluginData.set(PLUGIN_ID, DATA_KEY, ta.value)
      this.setStatus(`已保存 · ${this.nowTime()}`, 'saved')
    } catch {
      this.setStatus('保存失败', 'editing')
    }
  }

  async clear() {
    clearTimeout(this.saveTimer)
    const ta = this.shadowRoot.querySelector('textarea')
    ta.value = ''
    this.updateCounts()
    try {
      await window.api.pluginData.remove(PLUGIN_ID, DATA_KEY)
      this.setStatus('已清空', 'saved')
    } catch {
      this.setStatus('清除失败', 'editing')
    }
    ta.focus()
  }

  async copy() {
    const ta = this.shadowRoot.querySelector('textarea')
    if (!ta.value) {
      this.setStatus('暂无内容可复制', 'editing')
      return
    }
    try {
      await navigator.clipboard.writeText(ta.value)
      this.setStatus('已复制到剪贴板', 'saved')
    } catch {
      ta.select()
      document.execCommand('copy')
      this.setStatus('已复制到剪贴板', 'saved')
    }
  }

  setStatus(text, mode) {
    const el = this.shadowRoot.querySelector('.status')
    if (!el) return
    el.textContent = text
    el.classList.toggle('editing', mode === 'editing')
    el.classList.toggle('saved', mode === 'saved')
  }

  updateCounts() {
    const ta = this.shadowRoot.querySelector('textarea')
    const meta = this.shadowRoot.querySelector('.meta')
    if (!ta || !meta) return
    const chars = ta.value.length
    const lines = ta.value ? ta.value.split('\n').length : 0
    meta.textContent = `${chars} 字符 · ${lines} 行`
  }

  nowTime() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false })
  }

  // 生命周期钩子：挂载后由壳层调用
  onMount() {
    const el = this.shadowRoot?.querySelector('.status')
    if (el) {
      el.textContent = `已挂载 · ${this.nowTime()}`
      el.classList.add('saved')
    }
  }

  // 生命周期钩子：移除前由壳层调用
  onUnmount() {
    clearTimeout(this.saveTimer)
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; user-select: text; }
        * { box-sizing: border-box; }
        .note {
          width: 100%;
          max-width: 560px;
          padding: var(--space-5, 24px);
          background: var(--surface, #fff);
          border: 1px solid var(--border, #d9dce2);
          border-radius: var(--radius-lg, 10px);
          box-shadow: var(--shadow-1, 0 1px 2px rgba(16, 20, 28, 0.06));
          font-family: var(--font-ui, system-ui, sans-serif);
        }
        .head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2, 8px); margin-bottom: var(--space-4, 16px); }
        .eyebrow {
          font-family: var(--font-mono, monospace);
          font-size: var(--font-size-xs, 12px);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-muted, #5b6370);
        }
        .title { margin: var(--space-1, 4px) 0 0; font-size: var(--font-size-lg, 16px); font-weight: var(--font-weight-semibold, 600); line-height: var(--line-height-tight, 1.25); color: var(--text, #1a1d23); }
        .status {
          display: inline-flex; align-items: center; height: 20px; padding: 0 var(--space-2, 8px);
          border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-pill, 999px);
          font-family: var(--font-mono, monospace); font-size: var(--font-size-xs, 12px);
          color: var(--text-muted, #5b6370); white-space: nowrap;
          transition: color var(--duration-fast, 120ms) var(--ease-out, ease-out), border-color var(--duration-fast, 120ms) var(--ease-out, ease-out);
        }
        .status.editing { color: var(--accent, #0e7c6b); border-color: var(--accent, #0e7c6b); }
        .status.saved { color: var(--success, #1e7e4e); border-color: var(--success, #1e7e4e); }
        .editor {
          display: block; width: 100%; min-height: 132px;
          padding: var(--space-3, 12px);
          background: var(--surface-2, #eceef1);
          border: 1px solid var(--border, #d9dce2);
          border-radius: var(--radius-base, 6px);
          color: var(--text, #1a1d23);
          font-family: var(--font-ui, system-ui, sans-serif);
          font-size: var(--font-size-base, 14px);
          line-height: var(--line-height-base, 1.5);
          resize: vertical;
          outline: none;
          transition: border-color var(--duration-fast, 120ms) var(--ease-out, ease-out), box-shadow var(--duration-fast, 120ms) var(--ease-out, ease-out), background var(--duration-fast, 120ms) var(--ease-out, ease-out);
        }
        .editor:hover { border-color: var(--border-strong, #b6bcc7); }
        .editor:focus { border-color: var(--accent, #0e7c6b); background: var(--surface, #fff); box-shadow: 0 0 0 3px var(--focus-ring, rgba(14, 124, 107, 0.35)); }
        .editor::placeholder { color: var(--text-muted, #5b6370); }
        .bar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2, 8px); margin-top: var(--space-3, 12px); }
        .meta { font-family: var(--font-mono, monospace); font-size: var(--font-size-xs, 12px); color: var(--text-muted, #5b6370); font-variant-numeric: tabular-nums; }
        .actions { display: flex; gap: var(--space-2, 8px); }
        .btn {
          height: 28px; padding: 0 var(--space-3, 12px);
          border-radius: var(--radius-base, 6px);
          font-size: var(--font-size-sm, 13px);
          cursor: pointer; user-select: none;
          transition: background var(--duration-fast, 120ms) var(--ease-out, ease-out), border-color var(--duration-fast, 120ms) var(--ease-out, ease-out), color var(--duration-fast, 120ms) var(--ease-out, ease-out);
        }
        .btn.ghost { background: transparent; border: 1px solid var(--border-strong, #b6bcc7); color: var(--text, #1a1d23); }
        .btn.ghost:hover { background: var(--surface-2, #eceef1); }
        .btn.danger { background: transparent; border: 1px solid var(--danger, #b3372e); color: var(--danger, #b3372e); }
        .btn.danger:hover { background: var(--danger, #b3372e); color: var(--surface, #fff); }
        .btn:focus-visible { outline: 2px solid var(--focus-ring, rgba(14, 124, 107, 0.35)); outline-offset: 1px; }
      </style>
      <section class="note">
        <header class="head">
          <div>
            <span class="eyebrow">External Plugin · Note</span>
            <h3 class="title">便签</h3>
          </div>
          <span class="status saved">已保存</span>
        </header>
        <textarea class="editor" placeholder="写点什么…" spellcheck="false"></textarea>
        <footer class="bar">
          <span class="meta">0 字符 · 0 行</span>
          <div class="actions">
            <button type="button" class="btn ghost" data-action="copy">复制</button>
            <button type="button" class="btn danger" data-action="clear">清空</button>
          </div>
        </footer>
      </section>
    `
  }
}

customElements.define('app-plugin-demo-note', DemoNote)
