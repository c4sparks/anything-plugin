// 临时端到端验证脚本：通过 CDP 连接渲染层，驱动插件页 + Agent 打开流程。
// 用法：先 `pnpm dev -- --remote-debugging-port=9222`，再 `node scripts/drive-agent.mjs`
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
console.log('[drive] 目标页面:', page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))

// 1. 进插件页
await evalJs(ws, `document.querySelector('.activity-item[title="插件"]')?.click()`)
await new Promise((r) => setTimeout(r, 600))

// 2. 检查 banner 已移除 + Agent 行存在
const check = await evalJs(ws, `(() => {
  const banner = document.querySelector('.agent-banner')
  const rows = [...document.querySelectorAll('.pm-row')]
  const agentRow = rows.find(r => r.textContent.includes('DeepSeek Harness Agent'))
  const name = agentRow?.querySelector('.pm-name')?.textContent?.trim()
  return { bannerGone: !banner, agentRowInList: !!agentRow, firstRowName: name }
})()`)
console.log('[drive] 插件页检查:', JSON.stringify(check))

// 3. 点 Agent 行的「打开」→ 应进 agent 页并启动侧车
await evalJs(ws, `(() => {
  const row = [...document.querySelectorAll('.pm-row')].find(r => r.textContent.includes('DeepSeek Harness Agent'))
  const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '打开')
  btn?.click()
  return !!btn
})()`)
await new Promise((r) => setTimeout(r, 8000))

const agentActive = await evalJs(ws, `(() => {
  const card = [...document.querySelectorAll('.sidebar-scroll .slot-card')].find((b) => b.textContent.includes('AI 助手'))
  return card?.classList.contains('active') ?? false
})()`)
console.log('[drive] 打开后 hostApp 视图激活:', agentActive)

ws.close()
console.log('[drive] 完成 —— 核对主进程日志 [agent] ready / view loaded')
