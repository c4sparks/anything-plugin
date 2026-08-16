// build-plugin：打包型外部插件构建脚本（约定见 plugins-dev/README.md 与 docs/插件开发速查.md §⑤）
// 用法：node scripts/build-plugin.mjs <id> [--debug]
//  - 源码：plugins-dev/<id>/src/entry.js（npm 依赖随意用）
//  - 产物：resources/plugins/<id>/entry.js（单文件 ESM，minify；--debug 不压缩 + sourcemap）+ manifest.json
//  - 约束：entry.js ≤2MB（超限报错）
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const id = process.argv[2]
const debug = process.argv.includes('--debug')

if (!id || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) {
  console.error('用法: node scripts/build-plugin.mjs <id> [--debug]')
  process.exit(1)
}

const srcDir = join(root, 'plugins-dev', id)
const outDir = join(root, 'resources', 'plugins', id)
const entry = join(srcDir, 'src', 'entry.js')
const manifest = join(srcDir, 'manifest.json')

if (!existsSync(entry) || !existsSync(manifest)) {
  console.error(`[build-plugin] 缺少 ${entry} 或 ${manifest}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: join(outDir, 'entry.js'),
  minify: !debug,
  sourcemap: debug ? 'linked' : false,
  define: { 'process.env.NODE_ENV': debug ? '"development"' : '"production"' },
  logLevel: 'info',
})

copyFileSync(manifest, join(outDir, 'manifest.json'))

const size = statSync(join(outDir, 'entry.js')).size
if (size > 2 * 1024 * 1024) {
  console.error(`[build-plugin] ${id}/entry.js 超过 2MB（${size} 字节），拒绝`)
  process.exit(1)
}

// 确认产物无裸导入（单文件 ESM 自包含）
const bundled = readFileSync(join(outDir, 'entry.js'), 'utf-8')
const bareImport = /(?:^|[;\n])\s*import\s+[^'"`]+?\s+from\s+['"](?!\.{1,2}\/)/m
if (!debug && bareImport.test(bundled)) {
  console.error('[build-plugin] 产物含裸导入，打包不完整')
  process.exit(1)
}

console.log(
  `[build-plugin] ${id} → resources/plugins/${id}/entry.js (${(size / 1024).toFixed(1)}KB${debug ? ', debug+sourcemap' : ', minified'})`,
)
