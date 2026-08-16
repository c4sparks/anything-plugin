// dsh:smoke —— 验证 npm 拉下来的 @deepseek-ai/dsh 闭包能独立 boot 出 web host。
// spawn 系统 node 跑 bin.js web --port 0 → 解析就绪行拿端口 → fetch / 断言 SPA 可服务。
// 通过退出 0；失败打印原因退出非 0。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const READY_RE = /dsh web:\s*http:\/\/127\.0\.0\.1:(\d+)/i
const READY_TIMEOUT = 30_000

const root = fileURLToPath(new URL('..', import.meta.url))
const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const dshHome = join(root, '.dsh-dev')

if (!existsSync(bin)) {
  console.error(`[dsh:smoke] 找不到 ${bin} —— 先 pnpm install`)
  process.exit(1)
}

console.log(`[dsh:smoke] spawn: node ${bin} web --port 0`)
console.log(`[dsh:smoke] DSH_HOME=${dshHome}`)

const child = spawn('node', [bin, 'web', '--port', '0'], {
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let buf = ''
let stderr = ''
let port = 0
let settled = false

function fail(msg) {
  if (settled) return
  settled = true
  console.error(`[dsh:smoke] FAIL: ${msg}`)
  console.error(stderr || '(no stderr)')
  child.kill()
  process.exit(1)
}

function pass(msg) {
  if (settled) return
  settled = true
  console.log(`[dsh:smoke] OK: ${msg}`)
  child.kill()
  process.exit(0)
}

const timer = setTimeout(() => {
  fail(`等待就绪行超时（${READY_TIMEOUT / 1000}s）`)
}, READY_TIMEOUT)

child.stdout.on('data', (c) => {
  buf += c.toString()
  const m = READY_RE.exec(buf)
  if (m && !port) {
    port = Number(m[1])
    console.log(`[dsh:smoke] 就绪端口 ${port}`)
    verify()
  }
})

child.stderr.on('data', (c) => {
  stderr += c.toString()
})

child.on('exit', (code, sig) => {
  clearTimeout(timer)
  if (!settled && code !== 0) fail(`dsh 提前退出 code=${code} sig=${sig}`)
})

async function verify() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    const html = await res.text()
    if (res.status !== 200) return fail(`GET / 返回 HTTP ${res.status}`)
    if (!html.includes('__DSH_BOOT__')) return fail('index.html 缺少 __DSH_BOOT__（host 未注入 manifest）')
    pass(`GET / 200 且含 __DSH_BOOT__（${html.length} bytes）`)
  } catch (err) {
    fail(`fetch 失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
