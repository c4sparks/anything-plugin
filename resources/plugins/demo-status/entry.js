// 测试插件：状态栏运行状态（statusbar 槽位）。无依赖、单文件、纯 ES Module 原生 Web Component。
// 功能：实时显示已运行时长（每秒刷新，mm:ss / hh:mm:ss）；卸载时清理定时器（铁律）。
class DemoStatus extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: 'open' })
    this.start = Date.now()
    this.render()
    this.timer = setInterval(() => this.update(), 1000)
    this.update()
  }

  disconnectedCallback() {
    clearInterval(this.timer)
  }

  fmt(sec) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    const pad = (n) => String(n).padStart(2, '0')
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  }

  update() {
    const s = Math.max(0, Math.floor((Date.now() - this.start) / 1000))
    const el = this.shadowRoot?.querySelector('.uptime')
    if (el) el.textContent = this.fmt(s)
  }

  render() {
    if (!this.shadowRoot) return
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-flex; align-items: center; }
        .chip {
          display: inline-flex; align-items: center; gap: var(--space-1, 4px);
          height: 20px; padding: 0 var(--space-2, 8px);
          border-radius: var(--radius-pill, 999px);
          color: var(--text-muted, #5b6370);
          font-family: var(--font-mono, monospace);
          font-size: var(--font-size-xs, 12px);
          transition: background var(--duration-fast, 120ms) var(--ease-out, ease-out);
        }
        .chip:hover { background: var(--surface-2, #eceef1); }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success, #1e7e4e); animation: pulse 2s var(--ease-out, ease-out) infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        .uptime { font-weight: var(--font-weight-semibold, 600); color: var(--text, #1a1d23); font-variant-numeric: tabular-nums; }
        @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
      </style>
      <span class="chip" title="运行时长" role="timer">
        <i class="dot"></i><span>运行</span><b class="uptime">00:00</b>
      </span>
    `
  }
}

customElements.define('app-plugin-demo-status', DemoStatus)
