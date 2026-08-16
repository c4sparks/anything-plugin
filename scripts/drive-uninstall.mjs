// 临时验证：卸载 → hostApp 消失 → 重新安装 → 恢复
const PORT = 9222
const BASE = `http://127.0.0.1:${PORT}`
async function evalJs(ws, expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const timer = setTimeout(() => reject(new Error('CDP 超时')), 5000)
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
if (!page) { console.error('[drive] 未找到页面'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))

// confirm 全通过 + 进插件页
await evalJs(ws, `window.confirm = () => true`)
await evalJs(ws, `document.querySelector('.activity-item[title="插件"]')?.click()`)
await new Promise((r) => setTimeout(r, 600))

// 点 hostApp 行「卸载」
const clickedUninstall = await evalJs(ws, `(() => {
  const row = [...document.querySelectorAll('.pm-row')].find(r => r.textContent.includes('DeepSeek Harness Agent'))
  const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '卸载')
  btn?.click(); return !!btn
})()`)
console.log('[卸载] 点击卸载按钮:', clickedUninstall)
await new Promise((r) => setTimeout(r, 1500))

// 检查：hostApp 从侧栏消失 + 出现重装行
const afterUninstall = await evalJs(ws, `(() => {
  const sidebarHas = [...document.querySelectorAll('.sidebar-scroll .slot-card')].some(e => e.textContent.includes('AI 助手'))
  const reinstallRow = [...document.querySelectorAll('.pm-row')].some(r => r.textContent.includes('已卸载'))
  return { sidebarHas, reinstallRow }
})()`)
console.log('[卸载] 卸载后:', JSON.stringify(afterUninstall))

// 点「重新安装」
const clickedReinstall = await evalJs(ws, `(() => {
  const row = [...document.querySelectorAll('.pm-row')].find(r => r.textContent.includes('已卸载'))
  const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '重新安装')
  btn?.click(); return !!btn
})()`)
console.log('[重装] 点击重新安装:', clickedReinstall)
await new Promise((r) => setTimeout(r, 800))

const afterReinstall = await evalJs(ws, `(() => {
  const sidebarHas = [...document.querySelectorAll('.sidebar-scroll .slot-card')].some(e => e.textContent.includes('AI 助手'))
  const row = [...document.querySelectorAll('.pm-row')].find(r => r.textContent.includes('DeepSeek Harness Agent'))
  return { sidebarHas, rowBack: !!row }
})()`)
console.log('[重装] 重装后:', JSON.stringify(afterReinstall))

ws.close()
