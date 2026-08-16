// create-plugin：脚手架 —— 生成四类插件骨架。
// 交互式（不带参数，逐步提问）：
//   node scripts/create-plugin.mjs
// 参数式（脚本化）：
//   node scripts/create-plugin.mjs <vue|native|external|hostapp> <id> [名称] [slot]
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface, emitKeypressEvents } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

/** 插件类型（含简短功能简介） */
const TYPES = [
  { value: 'vue', label: '内置 Vue SFC', desc: 'Vue 组件挂壳层槽位，随壳编译（HMR 热更）' },
  { value: 'native', label: '内置原生 Web Component', desc: '原生自定义元素，随壳编译' },
  { value: 'external', label: '外部 webComponent', desc: '放插件目录自动发现，纯原生 WC（无依赖）' },
  { value: 'hostapp', label: 'hostApp 外部宿主', desc: '独立进程运行，嵌入其 Web UI（如 agent）' },
]

/** 槽位（含简短功能简介） */
const SLOTS = [
  { value: 'sidebar', label: 'sidebar', desc: '侧栏小部件，堆叠内联渲染' },
  { value: 'content', label: 'content', desc: '内容区视图，单一激活（点侧栏打开）' },
  { value: 'statusbar', label: 'statusbar', desc: '状态栏小部件，常驻底部' },
]

function typeLabel(value) {
  return TYPES.find((t) => t.value === value)?.label ?? value
}

/** 示例部件：按槽位生成对应布局，宽高对齐 docs/设计规范.md（样式只依赖主题 CSS 变量）：
 *  content —— 居中卡片页（点侧栏在右侧打开，像 Hello）
 *  sidebar —— 整宽紧凑卡片（贴合 200px 侧栏，--space-3 内边距）
 *  statusbar —— 内联条（贴合 --statusbar-height 28px，xs mono） */
function widgetParts(slot, name, countExpr, clickAttr) {
  // content：居中卡片页
  if (slot === 'content') {
    const btn = `<button class="cta" ${clickAttr}>+1</button>`
    const body = `<div class="wrap"><div class="card"><span class="ic">🧩</span><h3 class="title">${name}</h3><p class="desc">计数示例插件（create-plugin 生成）</p><div class="counter"><span class="num">${countExpr}</span>${btn}</div></div></div>`
    const css = `:host { display: flex; justify-content: center; padding: var(--space-6, 32px); }
      .wrap { width: 100%; max-width: 360px; }
      .card { padding: var(--space-5, 24px); background: var(--surface, #fff); border: 1px solid var(--border, #d9dce2); border-radius: var(--radius-lg, 10px); box-shadow: var(--shadow-1, 0 1px 3px rgba(0,0,0,.1)); text-align: center; box-sizing: border-box; }
      .ic { font-size: 28px; }
      .title { margin: var(--space-2, 8px) 0 0; font-size: 18px; font-weight: 600; color: var(--text, #1a1d23); }
      .desc { margin: var(--space-1, 4px) 0 var(--space-4, 16px); font-size: 13px; color: var(--text-muted, #5b6370); }
      .counter { display: flex; align-items: center; justify-content: center; gap: var(--space-3, 12px); }
      .num { font-family: var(--font-mono, ui-monospace, monospace); font-size: 26px; font-weight: 600; color: var(--accent, #0e7c6b); min-width: 2ch; }
      .cta { height: 34px; padding: 0 var(--space-5, 24px); border: none; border-radius: var(--radius-base, 6px); background: var(--accent, #0e7c6b); color: var(--accent-text, #fff); font-size: 13px; font-weight: 500; cursor: pointer; }
      .cta:hover { filter: brightness(0.92); }`
    return { body, css }
  }
  // sidebar：整宽紧凑卡片（demo-sidebar 风格）
  if (slot === 'sidebar') {
    const body = `<div class="box"><div class="row"><span class="name">${name}</span><span class="num">${countExpr}</span></div><div class="btns"><button class="plus" ${clickAttr}>+1</button></div></div>`
    const css = `:host { display: block; }
      .box { display: flex; flex-direction: column; gap: var(--space-2, 8px); padding: var(--space-3, 12px); background: var(--surface-2, #eceef1); border-radius: var(--radius-base, 6px); box-sizing: border-box; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2, 8px); }
      .name { font-size: var(--font-size-xs, 12px); color: var(--text-muted, #5b6370); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .num { font-family: var(--font-mono, monospace); font-size: var(--font-size-lg, 16px); font-weight: var(--font-weight-semibold, 600); color: var(--accent, #0e7c6b); flex: none; }
      .btns { display: flex; gap: var(--space-1, 4px); }
      .plus { height: 22px; padding: 0 var(--space-2, 8px); border: 1px solid var(--border-strong, #b6bcc7); border-radius: var(--radius-sm, 4px); background: var(--surface, #fff); color: var(--text, #1a1d23); font-size: var(--font-size-xs, 12px); cursor: pointer; }
      .plus:hover { background: var(--surface-2, #eceef1); }`
    return { body, css }
  }
  // statusbar：内联条（demo-status 风格，贴合 28px 高度）
  const body = `<span class="item"><i class="dot"></i><span class="name">${name}</span><b class="num">${countExpr}</b><button class="plus" ${clickAttr}>+1</button></span>`
  const css = `:host { display: inline-flex; align-items: center; }
    .item { display: inline-flex; align-items: center; gap: var(--space-2, 8px); font-family: var(--font-mono, monospace); font-size: var(--font-size-xs, 12px); color: var(--text-muted, #5b6370); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success, #1e7e4e); flex: none; }
    .name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .num { font-weight: var(--font-weight-semibold, 600); color: var(--accent, #0e7c6b); }
    .plus { height: 20px; padding: 0 var(--space-2, 8px); border: 1px solid var(--border-strong, #b6bcc7); border-radius: var(--radius-sm, 4px); background: var(--surface, #fff); color: var(--text, #1a1d23); font-size: var(--font-size-xs, 12px); cursor: pointer; line-height: 1; }
    .plus:hover { background: var(--surface-2, #eceef1); }`
  return { body, css }
}

function pascal(s) {
  return s.split(/[-_]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

/** 移除脚手架生成的插件：内置（index.ts 注册块 + widget 文件）/ 外部（插件目录 + 包骨架） */
function removePlugin(pid) {
  let removed = false
  // 1) 内置：index.ts 里找注册块
  const indexFile = join(root, 'src/renderer/src/plugins/index.ts')
  if (existsSync(indexFile)) {
    const lines = readFileSync(indexFile, 'utf-8').split('\n')
    const markerIdx = lines.findIndex((l) => l.includes(`// ===== 新增插件：${pid}`))
    if (markerIdx !== -1) {
      let end = lines.length - 1
      for (let i = markerIdx + 1; i < lines.length; i++) {
        if (lines[i].includes('// ===== 新增插件：')) {
          end = i - 1
          break
        }
        const t = lines[i].trim()
        if (
          (t.startsWith('registerPlugin(') && t.endsWith('})')) ||
          (t.startsWith('registerVuePlugin(') && t.endsWith(')'))
        ) {
          end = i
          break
        }
        if (t === ')' && lines.slice(markerIdx, i).some((l) => l.includes('register'))) {
          end = i
          break
        }
      }
      const block = lines.slice(markerIdx, end + 1).join('\n')
      const imp =
        block.match(/from '\.\/widgets\/([^']+)'/) || block.match(/import '\.\/widgets\/([^']+)'/)
      if (imp) {
        for (const c of [imp[1], imp[1] + '.ts', imp[1] + '.vue']) {
          const f = join(root, 'src/renderer/src/plugins/widgets', c)
          if (existsSync(f)) {
            rmSync(f)
            console.log(`  已删除 ${f}`)
          }
        }
      }
      lines.splice(markerIdx, end - markerIdx + 1)
      writeFileSync(indexFile, lines.join('\n').replace(/\n{3,}/g, '\n\n'))
      console.log(`✅ 内置插件「${pid}」已移除注册 + widget 文件`)
      removed = true
    }
  }
  // 2) 外部 / hostApp：删插件目录 + 包骨架
  const extDir = join(root, 'resources/plugins', pid)
  if (existsSync(extDir)) {
    rmSync(extDir, { recursive: true, force: true })
    console.log(`✅ 已删除插件目录 ${extDir}`)
    removed = true
  }
  const pkgDir = join(root, 'resources', pid)
  if (existsSync(join(pkgDir, 'package.json'))) {
    rmSync(pkgDir, { recursive: true, force: true })
    console.log(`✅ 已删除包骨架 ${pkgDir}`)
  }
  if (!removed) console.log(`⚠ 未找到插件「${pid}」`)
}

/** 内置插件：把注册代码追加到 plugins/index.ts（带清晰标记，便于审查） */
function appendBuiltin(importLine, registerCode) {
  const file = join(root, 'src/renderer/src/plugins/index.ts')
  appendFileSync(file, `\n// ===== 新增插件：${id}（create-plugin 生成）=====\n${importLine}\n${registerCode}\n`)
  console.log(`  已追加注册到 ${file}`)
}

function writeFileSafe(p, content) {
  if (existsSync(p)) {
    console.error(`  ⚠ 已存在，跳过: ${p}`)
    return false
  }
  writeFileSync(p, content)
  return true
}

// ---------- ① 内置 Vue SFC ----------
function createVue() {
  const comp = pascal(id)
  const file = join(root, 'src/renderer/src/plugins/widgets', `${comp}.vue`)
  const { body, css } = widgetParts(slot, name, '{{ count }}', '@click="count++"')
  const vueCss = css.replaceAll(':host', `.${id}`)
  const ok = writeFileSafe(
    file,
    `<script setup lang="ts">
// 插件「${name}」（create-plugin 生成）。槽位 ${slot}；样式只依赖主题 CSS 变量。
import { ref } from 'vue'
const count = ref(0)
</script>

<template>
  <div class="${id}">${body}</div>
</template>

<style scoped>
${vueCss}
</style>
`,
  )
  if (!ok) process.exit(1)
  appendBuiltin(
    `import ${comp} from './widgets/${comp}.vue'`,
    `registerVuePlugin(\n  { id: '${id}', name: '${name}', kind: 'webComponent', tag: '${tag}', slot: '${slot}', order: 20, source: 'builtin', tier: 'trusted', enabled: true },\n  ${comp},\n)`,
  )
  console.log(`✅ 内置 Vue 插件「${name}」创建完成（${file}）`)
}

// ---------- ② 内置原生 Web Component ----------
function createNative() {
  const Cls = pascal(id)
  const file = join(root, 'src/renderer/src/plugins/widgets', `${id}.ts`)
  const { body, css } = widgetParts(slot, name, '${this.count}', '')
  const ok = writeFileSafe(
    file,
    `// 插件「${name}」（create-plugin 生成）：原生 Web Component。槽位 ${slot}。
export class ${Cls} extends HTMLElement {
  count = 0
  connectedCallback() {
    this.attachShadow({ mode: 'open' })
    // 事件委托：按钮点击 +1（避免 render 重建后重复绑定）
    this.shadowRoot.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) {
        this.count++
        this.render()
      }
    })
    this.render()
  }
  disconnectedCallback() {
    // 铁律：清理定时器/监听器
  }
  render() {
    if (!this.shadowRoot) return
    this.shadowRoot.innerHTML = \`<style>${css}</style>${body}\`
  }
}
customElements.define('${tag}', ${Cls})
`,
  )
  if (!ok) process.exit(1)
  appendBuiltin(
    `import { registerPlugin } from './registry'\nimport './widgets/${id}'`,
    `registerPlugin({ id: '${id}', name: '${name}', kind: 'webComponent', tag: '${tag}', slot: '${slot}', order: 20, source: 'builtin', tier: 'trusted', enabled: true })`,
  )
  console.log(`✅ 内置原生 WC 插件「${name}」创建完成（${file}）`)
}

// ---------- ③ 外部 webComponent ----------
function createExternal() {
  const dir = join(root, 'resources/plugins', id)
  mkdirSync(dir, { recursive: true })
  writeFileSafe(
    join(dir, 'manifest.json'),
    JSON.stringify(
      { id, name, kind: 'webComponent', slot, tag, entry: 'entry.js', version: '1.0.0', description: `${name} 插件` },
      null,
      2,
    ),
  )
  const { body, css } = widgetParts(slot, name, '${this.count}', '')
  writeFileSafe(
    join(dir, 'entry.js'),
    `// 外部插件「${name}」（create-plugin 生成）：无依赖、单文件、纯 ESM 原生 WC。槽位 ${slot}。
class ${pascal(id)} extends HTMLElement {
  count = 0
  connectedCallback() {
    this.attachShadow({ mode: 'open' })
    // 事件委托：按钮点击 +1（避免 render 重建后重复绑定）
    this.shadowRoot.addEventListener('click', (e) => {
      if (e.target.closest('button')) {
        this.count++
        this.render()
      }
    })
    this.render()
  }
  disconnectedCallback() {
    // 铁律：清理定时器/监听器
  }
  render() {
    if (!this.shadowRoot) return
    this.shadowRoot.innerHTML = \`<style>${css}</style>${body}\`
  }
}
customElements.define('${tag}', ${pascal(id)})
`,
  )
  console.log(`✅ 外部 webComponent 插件「${name}」创建完成（${dir}）`)
  console.log('  放目录即自动发现；dev 下插件页自动出现。')
}

// ---------- ④ hostApp ----------
function createHostApp() {
  const dir = join(root, 'resources/plugins', id)
  const pkgDir = join(root, 'resources', id)
  mkdirSync(join(dir), { recursive: true })
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSafe(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id,
        name,
        kind: 'hostApp',
        slot,
        shortName: name,
        iconName: 'box',
        description: `${name} 宿主应用`,
        version: '1.0.0',
        hostApp: {
          packageName: id,
          hostBin: 'lib/bin.js',
          cliArgs: ['--port', '0'],
          readyRe: `${id}: http://127\\.0\\.0\\.1:(\\d+)`,
          dataHomeEnv: `${id.replace(/-/g, '_').toUpperCase()}_HOME`,
          dataDir: id,
          runtimeDir: `${id}-runtime`,
          extraEnv: {},
        },
      },
      null,
      2,
    ),
  )
  writeFileSafe(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: id, version: '1.0.0', private: true, type: 'commonjs', main: 'lib/bin.js' }, null, 2),
  )
  writeFileSafe(
    join(pkgDir, 'lib', 'bin.js'),
    `// 「${name}」宿主程序（create-plugin 生成）：stdout 打就绪行 + HTTP Web UI。
const http = require('node:http')
const i = process.argv.indexOf('--port')
const port = i >= 0 ? Number(process.argv[i + 1]) : 0
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(\`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${name}</title><style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #f6f7f9; display: flex; justify-content: center; padding: 48px 16px; }
  .card { width: 100%; max-width: 360px; padding: 24px; background: #fff; border: 1px solid #e3e5ea; border-radius: 10px;
          box-shadow: 0 2px 8px rgba(0,0,0,.08); text-align: center; box-sizing: border-box; }
  .ic { font-size: 28px; }
  .title { margin: 8px 0 0; font-size: 20px; font-weight: 600; color: #1a1d23; }
  .desc { margin: 4px 0 16px; font-size: 13px; color: #5b6370; }
  .counter { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .num { font-family: ui-monospace, monospace; font-size: 26px; font-weight: 600; color: #0e7c6b; min-width: 2ch; }
  .cta { height: 34px; padding: 0 20px; border: none; border-radius: 6px; background: #0e7c6b; color: #fff;
         font-size: 13px; font-weight: 500; cursor: pointer; }
  .cta:hover { filter: brightness(0.92); }
</style></head><body>
<div class="card">
  <span class="ic">🧩</span>
  <h1 class="title">${name}</h1>
  <p class="desc">${id} hostApp · 计数示例</p>
  <div class="counter">
    <span class="num" id="n">0</span>
    <button class="cta" onclick="document.getElementById('n').textContent = +document.getElementById('n').textContent + 1">+1</button>
  </div>
</div>
</body></html>\`)
})
server.listen(port, '127.0.0.1', () => {
  console.log(\`${id}: http://127.0.0.1:\${server.address().port}\`)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
`,
  )
  console.log(`✅ hostApp 插件「${name}」创建完成（${dir}）`)
  console.log(`  包骨架：${pkgDir}`)
  console.log(`  若需被 resolveHostBin 找到：package.json 加 "file:./resources/${id}" 依赖后 pnpm install`)
}

// ---------- 参数收集（交互式 or 参数式）----------
// 文本输入：手动写提示 + 等 'line' 事件（顺序读多行可靠）。关键是用
// rl.setPrompt() 让 readline 行编辑重绘整行时保留提示文本——否则 readline 会用
// 默认提示 '> ' 重绘整行，把「插件 id…」等内容覆盖掉、退格时只剩 '>'。
// 箭头菜单用 keypress 事件：readline 已创建时摘除其内部 keypress 监听，
// 防止行编辑把方向键/数字吞进输入缓冲。
let rl = null
const inputQueue = []
let inputResolver = null
function getRl() {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on('line', (line) => {
      if (inputResolver) {
        const r = inputResolver
        inputResolver = null
        r(line)
      } else {
        inputQueue.push(line)
      }
    })
  }
  return rl
}
function nextLine() {
  if (inputQueue.length) return Promise.resolve(inputQueue.shift())
  return new Promise((resolve) => {
    inputResolver = resolve
  })
}
function ask(prompt, fallback = '') {
  const rl = getRl()
  const text = `${prompt}${fallback ? ` [${fallback}]` : ''}: `
  rl.setPrompt(text)
  process.stdout.write(text)
  return nextLine().then((line) => line.trim() || fallback)
}

/** 选择项：TTY 用箭头菜单，非 TTY 用数字列表（返回选中 index）。options 为 {label, desc}[] */
async function selectOne(title, options, fallback = 0) {
  if (process.stdin.isTTY) return selectMenu(title, options, fallback)
  console.log(title)
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label} —— ${o.desc}`))
  const pick = await ask('选择', String(fallback + 1))
  const n = Number(pick)
  return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : fallback
}

/** 箭头选择菜单：↑/↓ 移动（选中绿 ▸ + 绿简介），Enter 确认，数字键直接选中确认 */
function selectMenu(title, options, fallback = 0) {
  return new Promise((resolve) => {
    // readline 未创建时自行开启 keypress 事件 + raw 模式；已创建则交由 readline 维护
    const ownRaw = rl === null
    const saved = process.stdin.listeners('keypress') // readline 内部监听（结束时恢复）
    if (ownRaw) {
      emitKeypressEvents(process.stdin)
      process.stdin.setRawMode(true)
    } else {
      process.stdin.removeAllListeners('keypress') // 摘除，避免行编辑吞掉按键
    }
    let index = fallback
    const count = options.length
    const totalLines = count * 2 + 1 // 标题 + 每项 2 行（label + desc）
    const draw = () => {
      process.stdout.write(`\x1b[${totalLines}A`) // 光标上移回标题行
      process.stdout.write(`\r\x1b[K${title}\n`)
      options.forEach((opt, i) => {
        const selected = i === index
        process.stdout.write('\r\x1b[K')
        process.stdout.write(
          selected ? `\x1b[32m▸ ${i + 1}) ${opt.label}\x1b[0m\n` : `  ${i + 1}) ${opt.label}\n`,
        )
        process.stdout.write(`\r\x1b[K     ${selected ? '\x1b[32m' : '\x1b[90m'}${opt.desc}\x1b[0m\n`)
      })
    }
    draw()
    const finish = () => {
      process.stdin.off('keypress', onKey)
      if (!ownRaw) for (const l of saved) process.stdin.on('keypress', l)
      if (ownRaw) process.stdin.setRawMode(false)
      process.stdout.write('\n')
      resolve(index)
    }
    const onKey = (str, key) => {
      if (!key) return
      if (key.name === 'up') {
        index = (index - 1 + count) % count
        draw()
      } else if (key.name === 'down') {
        index = (index + 1) % count
        draw()
      } else if (key.name === 'return' || key.name === 'enter') {
        finish()
      } else if (key.ctrl && key.name === 'c') {
        process.exit(1) // raw 模式下 Ctrl+C 不产生信号，手动退出
      } else if (str && /^[1-9]$/.test(str)) {
        const n = Number(str)
        if (n >= 1 && n <= count) {
          index = n - 1
          draw()
        }
      }
    }
    process.stdin.on('keypress', onKey)
    process.stdin.resume()
  })
}

let [, , type, id, name, slot] = process.argv

// ---------- remove 模式：移除脚手架生成的插件 ----------
if (type === 'remove') {
  if (!id || !ID_RE.test(id)) {
    console.error('用法: node scripts/create-plugin.mjs remove <id>')
    process.exit(1)
  }
  removePlugin(id)
  process.exit(0)
}

const interactive = !type || !id

if (!type) type = TYPES[await selectOne('插件类型：', TYPES, 2)].value // 默认 external（可卸载）
if (!id) id = await ask('插件 id（小写字母/数字/_-，如 demo-todo）')
if (!name) name = interactive ? await ask('插件名称', id) : id
if (!slot) slot = SLOTS[await selectOne('槽位：', SLOTS, SLOTS.findIndex((s) => s.value === 'content'))].value

if (!TYPES.some((t) => t.value === type)) {
  console.error(`❌ 插件类型非法：${type}（可选 ${TYPES.map((t) => t.value).join(' | ')}）`)
  process.exit(1)
}
if (!ID_RE.test(id)) {
  console.error(`❌ id 非法：必须匹配 ${ID_RE}`)
  process.exit(1)
}
if (!SLOTS.some((s) => s.value === slot)) {
  console.error(`❌ slot 非法：${SLOTS.map((s) => s.value).join(' | ')}`)
  process.exit(1)
}

const tag = `app-plugin-${id}`
console.log(`\n生成 ${typeLabel(type)} 插件：id=${id} 名称=${name} slot=${slot}\n`)

switch (type) {
  case 'vue':
    createVue()
    break
  case 'native':
    createNative()
    break
  case 'external':
    createExternal()
    break
  case 'hostapp':
    createHostApp()
    break
}

rl?.close()
