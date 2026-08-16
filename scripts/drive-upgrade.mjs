// 临时验证脚本：进插件页，检查 Agent 行版本检查 UI。
const PORT = 9222
const BASE = `http://127.0.0.1:${PORT}`
async function evalJs(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), 5000)
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMsg)
        if (msg.error) return reject(new Error(`CDP 错误: ${JSON.stringify(msg.error)}`))
        resolve(msg.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}
const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && /localhost:\d+/.test(t.url))
if (!page) { console.error('[drive] 未找到渲染层页面'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))

// 进插件页
await evalJs(ws, `document.querySelector('.activity-item[title="插件"]')?.click()`)
await new Promise((r) => setTimeout(r, 2500)) // 等 checkUpdate 返回

// 读 Agent 行 meta 文本 + 是否有升级/检查按钮
const info = await evalJs(ws, `(() => {
  const row = [...document.querySelectorAll('.pm-row')].find(r => r.textContent.includes('DeepSeek Harness Agent'))
  if (!row) return { found: false }
  const meta = row.querySelector('.pm-meta')?.textContent?.trim()
  const btns = [...row.querySelectorAll('button')].map(b => b.textContent.trim())
  return { found: true, meta, btns }
})()`)
console.log('[drive] Agent 行:', JSON.stringify(info, null, 2))

ws.close()
console.log('[drive] 完成')
