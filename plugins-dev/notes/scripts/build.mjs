// 笔记插件构建脚本：独立插件包自足构建（不依赖框架 build:plugin）
// 用法：node scripts/build.mjs [--debug] [--watch]
//  - 源码：src/entry.ts（npm 依赖随意用；TS 由 esbuild 原生转译，不查类型）
//  - 类型检查：pnpm typecheck（tsc --noEmit）
//  - 产物：dist/entry.js（单文件 ESM，minify；--debug 不压缩 + sourcemap）+ dist/manifest.json
//  - 约束：entry.js ≤2MB（超限报错）；产物无裸导入（单文件 ESM 自包含）
//  - --watch：监听 src/ 与 manifest.json，改动自动重新构建（开发体验）；Ctrl+C 退出
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, watch as fsWatch } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const PLUGIN_ID = 'notes'
const root = fileURLToPath(new URL('..', import.meta.url))
const debug = process.argv.includes('--debug')
const watch = process.argv.includes('--watch')

const srcDir = join(root, 'src') // 源码目录（entry.ts 在此）
const manifest = join(root, 'manifest.json')
const outDir = join(root, 'dist')
const outfile = join(outDir, 'entry.js')

// 入口优先 entry.ts（TS），回退 entry.js（兼容遗留）
const entryCandidates = ['entry.ts', 'entry.mts', 'entry.js'].map((f) => join(srcDir, f))
const entry = entryCandidates.find((f) => existsSync(f))

if (!entry || !existsSync(manifest)) {
  console.error(`[build-plugin] 缺少 src/entry.ts|entry.js 或 manifest.json`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

/** 产物后处理：manifest 复制 + ≤2MB 校验 + 无裸导入校验 + 日志（每次构建都跑）。返回是否通过 */
function finalize() {
  try {
    copyFileSync(manifest, join(outDir, 'manifest.json'))
    const size = statSync(outfile).size
    if (size > 2 * 1024 * 1024) {
      console.error(`[build-plugin] ${PLUGIN_ID}/entry.js 超过 2MB（${size} 字节），拒绝`)
      return false
    }
    const bundled = readFileSync(outfile, 'utf-8')
    const bareImport = /(?:^|[;\n])\s*import\s+[^'"`]+?\s+from\s+['"](?!\.{1,2}\/)/m
    if (!debug && bareImport.test(bundled)) {
      console.error('[build-plugin] 产物含裸导入，打包不完整')
      return false
    }
    console.log(
      `[build-plugin] ${PLUGIN_ID} → ${outfile} (${(size / 1024).toFixed(1)}KB${debug ? ', debug+sourcemap' : ', minified'})`,
    )
    return true
  } catch (err) {
    console.error('[build-plugin] 后处理失败:', err)
    return false
  }
}

const baseOptions = {
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile,
  minify: !debug,
  sourcemap: debug ? 'linked' : false,
  define: { 'process.env.NODE_ENV': debug ? '"development"' : '"production"' },
  // 样式表以文本内联（hljs 主题 / katex CSS 经 `import xxx from '...css'` 打进单文件）
  loader: { '.css': 'text' },
  logLevel: 'info',
}

if (watch) {
  // esbuild 0.25 已移除 build()/context() 的 watch 选项（需用 context()），这里自建监听：
  // fs.watch src/（recursive）+ 根目录（仅 manifest.json），防抖后 ctx.rebuild() 增量重建。
  let ctx
  try {
    ctx = await context(baseOptions)
  } catch (err) {
    console.error(`[build-plugin] ${PLUGIN_ID} 初始构建失败（修正后重启 watch）:`)
    console.error(err.message)
    process.exit(1)
  }

  let building = false
  let pending = false
  const doBuild = async (label) => {
    if (building) {
      pending = true
      return
    }
    building = true
    try {
      const res = await ctx.rebuild()
      if (res.errors.length > 0) {
        for (const e of res.errors) console.error(`[build-plugin] ${PLUGIN_ID} 构建失败: ${e.text}`)
        return
      }
      finalize()
      if (label) console.log(`[build-plugin] ${PLUGIN_ID} ${label}`)
    } catch (err) {
      console.error(`[build-plugin] ${PLUGIN_ID} 构建失败: ${err.message}`)
    } finally {
      building = false
      if (pending) {
        pending = false
        void doBuild('已重新构建')
      }
    }
  }

  await doBuild('watch 已启动')

  let timer = null
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void doBuild('已重新构建'), 150)
  }

  // 监听 src/（recursive）；Windows 支持 recursive，Linux 回退非递归
  let watcher
  try {
    watcher = fsWatch(srcDir, { recursive: true }, (_event, filename) => {
      if (filename && (filename.startsWith('node_modules') || filename.startsWith('.git'))) return
      schedule()
    })
  } catch {
    watcher = fsWatch(srcDir, (_event, filename) => {
      if (filename === 'node_modules' || filename === '.git') return
      schedule()
    })
  }
  // 单独监听根目录的 manifest.json 改动
  const manifestWatcher = fsWatch(root, (_event, filename) => {
    if (filename === 'manifest.json') schedule()
  })

  console.log(`[build-plugin] ${PLUGIN_ID} watch 监听中…（Ctrl+C 退出）`)
  process.on('SIGINT', () => {
    watcher.close()
    manifestWatcher.close()
    ctx.dispose()
    process.exit(0)
  })
} else {
  try {
    await build(baseOptions)
  } catch (err) {
    console.error(`[build-plugin] ${PLUGIN_ID} 构建失败:`)
    console.error(err.message)
    process.exit(1)
  }
  if (!finalize()) process.exit(1)
}
