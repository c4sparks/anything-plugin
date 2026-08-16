// demo-host：外部宿主应用示例 —— 最小 HTTP 服务（自带生产级仪表面板页面）。
// 启动参数 --port <n>（0 = OS 分配）；就绪行 `demo-host: http://127.0.0.1:<port>`
// 供壳层 AgentManager 正则解析端口并加载 WebContentsView。
const http = require('node:http')
const startedAt = Date.now()

function portArg() {
  const i = process.argv.indexOf('--port')
  return i >= 0 ? Number(process.argv[i + 1]) : 0
}

function pageHtml({ pid }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Demo Host</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 32px;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #f3f4f6; color: #1a1d23;
  -webkit-font-smoothing: antialiased;
}
.panel {
  width: 100%; max-width: 560px;
  padding: 32px;
  background: #fff;
  border: 1px solid #d9dce2;
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(16, 20, 28, 0.06);
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.eyebrow {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
  color: #5b6370;
}
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  height: 20px; padding: 0 8px;
  border: 1px solid #d9dce2; border-radius: 999px;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 12px; color: #1e7e4e;
}
.live { width: 6px; height: 6px; border-radius: 50%; background: #1e7e4e; animation: pulse 2s ease-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
h1 { margin: 20px 0 0; font-size: 22px; font-weight: 600; line-height: 1.25; }
.lead { margin: 8px 0 0; font-size: 14px; line-height: 1.5; color: #5b6370; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 24px; }
.item { padding: 12px; background: #eceef1; border-radius: 6px; }
.item-label {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 12px; color: #5b6370;
}
.item-value {
  margin-top: 4px;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums;
  color: #1a1d23;
}
.item-value.accent { color: #0e7c6b; }
.foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 24px; padding-top: 12px;
  border-top: 1px solid #d9dce2;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 12px; color: #5b6370;
}
@media (prefers-color-scheme: dark) {
  body { background: #14161b; color: #e6e8ed; }
  .panel { background: #1c1f26; border-color: #2d323e; }
  .eyebrow, .lead, .item-label, .foot { color: #98a0ad; }
  .item { background: #242833; }
  .chip { border-color: #2d323e; color: #3eb975; }
  .live { background: #3eb975; }
  .item-value { color: #e6e8ed; }
  .item-value.accent { color: #35b59a; }
}
@media (prefers-reduced-motion: reduce) { .live { animation: none; } }
</style>
</head>
<body>
<main class="panel">
  <header class="head">
    <span class="eyebrow">Host App · Demo</span>
    <span class="chip"><i class="live"></i>运行中</span>
  </header>
  <h1>Demo Host</h1>
  <p class="lead">外部宿主应用（hostApp）示例：以独立进程运行，经 WebContentsView 嵌入壳层内容区。</p>
  <div class="grid">
    <div class="item">
      <div class="item-label">端口 PORT</div>
      <div class="item-value accent" id="port">--</div>
    </div>
    <div class="item">
      <div class="item-label">进程 PID</div>
      <div class="item-value" id="pid">--</div>
    </div>
    <div class="item">
      <div class="item-label">运行时长</div>
      <div class="item-value" id="uptime">00:00</div>
    </div>
  </div>
  <footer class="foot">
    <span id="tz">--</span>
    <span>独立进程 · 完全系统权限</span>
  </footer>
</main>
<script>
var started = __STARTED__;
var pid = __PID__;
function pad(n) { return String(n).padStart(2, '0'); }
function fmt(sec) {
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  return (h > 0 ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
}
function tick() {
  var el = document.getElementById('uptime');
  if (el) el.textContent = fmt(Math.max(0, Math.floor((Date.now() - started) / 1000)));
}
document.getElementById('port').textContent = location.port || '80';
document.getElementById('pid').textContent = pid;
document.getElementById('tz').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
tick();
setInterval(tick, 1000);
</script>
</body>
</html>`
    .replace('__STARTED__', String(startedAt))
    .replace('__PID__', String(pid))
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(pageHtml({ pid: process.pid }))
})

server.listen(portArg(), '127.0.0.1', () => {
  const { port } = server.address()
  console.log(`demo-host: http://127.0.0.1:${port}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
  })
}
