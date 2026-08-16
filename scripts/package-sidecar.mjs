// package-sidecar：准备打包版侧车运行时到 resources/dsh-host/。
// 1) dsh-host(.exe) = 重命名的系统 Node（本脚本由 node 运行，process.execPath 即 v22.20，与原生依赖 ABI 一致）
// 2) app/node_modules = npm install --prefix 生成的自包含闭包（@deepseek-ai/dsh，npm 扁平布局无 pnpm 符号链接）
// electron-builder 用 extraResources 把 resources/dsh-host/** 部署进安装包。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dshHostDir = join(root, 'resources', 'dsh-host')
const appDir = join(dshHostDir, 'app')
const hostExe = join(dshHostDir, process.platform === 'win32' ? 'dsh-host.exe' : 'dsh-host')

// 1) Node 运行时
mkdirSync(dshHostDir, { recursive: true })
copyFileSync(process.execPath, hostExe)
console.log(`[package-sidecar] Node -> ${hostExe}`)

// 2) 闭包：读取已装 dsh 版本，npm install --prefix 生成自包含 node_modules
const dshPkg = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
if (!existsSync(dshPkg)) {
  console.error('[package-sidecar] 未找到 @deepseek-ai/dsh，先 pnpm install')
  process.exit(1)
}
const dshVersion = JSON.parse(readFileSync(dshPkg, 'utf-8')).version

// 幂等：resources/dsh-host 已存在、dsh-host(.exe) 在、闭包内 dsh 版本与 node_modules 一致 → 跳过
// （demo-host 已改为插件目录自包含，闭包只含 dsh；dsh 版本未变即视为闭包最新）
const installedPkg = join(dshHostDir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
if (existsSync(hostExe) && existsSync(installedPkg)) {
  try {
    const installedVersion = JSON.parse(readFileSync(installedPkg, 'utf-8')).version
    if (installedVersion === dshVersion) {
      console.log(`[package-sidecar] 已是最新（dsh@${dshVersion}），跳过生成`)
      process.exit(0)
    }
    console.log(`[package-sidecar] dsh 版本变化 ${installedVersion} → ${dshVersion}，重新生成`)
  } catch {
    console.log('[package-sidecar] 闭包损坏，重新生成')
  }
} else {
  console.log('[package-sidecar] resources/dsh-host 缺失，开始生成')
}

rmSync(appDir, { recursive: true, force: true })
mkdirSync(appDir, { recursive: true })

const res = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--prefix', appDir, `@deepseek-ai/dsh@${dshVersion}`],
  { stdio: 'inherit', shell: process.platform === 'win32' },
)
if (res.status !== 0) {
  console.error(`[package-sidecar] npm install 失败 code=${res.status}`)
  process.exit(res.status ?? 1)
}
console.log(`[package-sidecar] 完成: ${dshHostDir} (dsh@${dshVersion})`)
