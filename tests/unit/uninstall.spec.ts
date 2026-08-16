import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// plugins.ts / pluginData.ts 顶层依赖 electron / @electron-toolkit/utils / ./settings
vi.mock('electron', () => {
  const userData = join(tmpdir(), 'pd-uninstall-' + Math.random().toString(36).slice(2))
  return {
    app: { getPath: () => userData, getAppPath: () => process.cwd() },
    dialog: {},
    BrowserWindow: class {},
  }
})
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../src/main/settings', () => ({
  getSettings: vi.fn(async () => ({ disabledPlugins: [] })),
}))

import { listPlugins, uninstallPlugin } from '../../src/main/plugins'
import { getPluginData, pluginDataRoot, setPluginData } from '../../src/main/pluginData'

const PLUGINS_ROOT = join(pluginDataRoot(), '..', 'plugins')
const DATA_ROOT = pluginDataRoot()

function installPlugin(id: string): void {
  const dir = join(PLUGINS_ROOT, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      name: id,
      kind: 'webComponent',
      tag: `app-plugin-${id}`,
      slot: 'content',
      entry: 'entry.js',
    }),
  )
  writeFileSync(
    join(dir, 'entry.js'),
    `class P extends HTMLElement {} customElements.define('app-plugin-${id}', P)`,
  )
}

afterEach(() => {
  rmSync(join(pluginDataRoot(), '..'), { recursive: true, force: true })
})

describe('uninstallPlugin 数据保留/清除', () => {
  it('默认卸载保留 plugin-data（重装可恢复）', async () => {
    installPlugin('t-keep')
    await listPlugins() // 扫描填充缓存
    await setPluginData('t-keep', 'text', 'v')
    await uninstallPlugin('t-keep')
    expect(existsSync(join(PLUGINS_ROOT, 't-keep'))).toBe(false)
    expect(await getPluginData('t-keep', 'text')).toBe('v')
  })

  it('clearData=true 卸载时一并清空 plugin-data', async () => {
    installPlugin('t-clear')
    await listPlugins()
    await setPluginData('t-clear', 'text', 'v')
    await uninstallPlugin('t-clear', true)
    expect(existsSync(join(PLUGINS_ROOT, 't-clear'))).toBe(false)
    expect(existsSync(join(DATA_ROOT, 't-clear'))).toBe(false)
  })

  it('非法 id 拒绝', async () => {
    await expect(uninstallPlugin('../evil')).rejects.toThrow('无效的插件 id')
    await expect(uninstallPlugin('')).rejects.toThrow('无效的插件 id')
  })
})
