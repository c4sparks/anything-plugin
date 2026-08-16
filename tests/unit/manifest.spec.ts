import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 主进程 plugins.ts 顶层 import electron / @electron-toolkit/utils / ./settings
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => process.cwd() },
  dialog: {},
  BrowserWindow: class {},
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../../src/main/settings', () => ({
  getSettings: vi.fn(async () => ({ disabledPlugins: [] })),
}))

import { findManifestDir, readAndValidateManifest } from '../../src/main/plugins'

let dirs: string[] = []

function tempManifest(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-test-'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(obj))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})

const validWeb = {
  id: 'demo-clock',
  name: '时钟',
  tag: 'app-plugin-demo-clock',
  slot: 'content',
  entry: 'entry.js',
}

const validHost = {
  id: 'my-host',
  name: 'My Host',
  kind: 'hostApp',
  slot: 'content',
  shortName: 'My',
  iconName: 'box',
  hostApp: {
    packageName: '@scope/my-host',
    hostBin: 'lib/bin.js',
    cliArgs: ['--port', '0'],
    readyRe: 'my-host: http://127\\.0\\.0\\.1:(\\d+)',
    dataHomeEnv: 'MY_HOST_HOME',
    dataDir: 'my-host',
    runtimeDir: 'my-host-runtime',
    extraEnv: { FLAG: '1' },
  },
}

describe('readAndValidateManifest', () => {
  it('webComponent manifest 通过（缺省 kind）', async () => {
    const m = await readAndValidateManifest(tempManifest(validWeb))
    expect(m).not.toBeNull()
    expect(m?.kind).toBe('webComponent')
    expect(m?.tag).toBe('app-plugin-demo-clock')
    expect(m?.entry).toBe('entry.js')
  })

  it('hostApp manifest 通过，返回 kind + hostApp 定义', async () => {
    const m = await readAndValidateManifest(tempManifest(validHost))
    expect(m).not.toBeNull()
    expect(m?.kind).toBe('hostApp')
    expect(m?.tag).toBeUndefined()
    expect(m?.entry).toBeUndefined()
    expect(m?.hostApp?.packageName).toBe('@scope/my-host')
    expect(m?.hostApp?.cliArgs).toEqual(['--port', '0'])
    expect(m?.hostApp?.dataDir).toBe('my-host')
  })

  it('未知 kind 拒绝', async () => {
    const m = await readAndValidateManifest(tempManifest({ ...validWeb, kind: 'weird' }))
    expect(m).toBeNull()
  })

  it('hostApp 缺 hostApp 定义拒绝', async () => {
    const m = await readAndValidateManifest(
      tempManifest({ id: 'h', name: 'H', kind: 'hostApp', slot: 'content' }),
    )
    expect(m).toBeNull()
  })

  it('hostApp packageName 注入（空格/分号/路径）拒绝', async () => {
    for (const pkg of ['bad name', 'x; rm -rf /', 'x/../../etc', 'UPPER-Case', 'a b']) {
      const m = await readAndValidateManifest(
        tempManifest({ ...validHost, hostApp: { ...validHost.hostApp, packageName: pkg } }),
      )
      expect(m, `packageName=${pkg}`).toBeNull()
    }
  })

  it('hostApp readyRe 非法（无捕获组 / 无法编译 / 空）拒绝', async () => {
    for (const re of ['no-capture-group', '(', '']) {
      const m = await readAndValidateManifest(
        tempManifest({ ...validHost, hostApp: { ...validHost.hostApp, readyRe: re } }),
      )
      expect(m, `readyRe=${re}`).toBeNull()
    }
  })

  it('hostApp hostDir 合法（"." 插件根）通过', async () => {
    const m = await readAndValidateManifest(
      tempManifest({ ...validHost, hostApp: { ...validHost.hostApp, hostDir: '.' } }),
    )
    expect(m?.hostApp?.hostDir).toBe('.')
  })

  it('hostApp hostDir 非法（越界/绝对/空白/空段）拒绝；空串视为未提供', async () => {
    const bad = ['../x', '/abs', 'a b', 'a//b']
    for (const hostDir of bad) {
      const m = await readAndValidateManifest(
        tempManifest({ ...validHost, hostApp: { ...validHost.hostApp, hostDir } }),
      )
      expect(m, `hostDir="${hostDir}" 应拒绝`).toBeNull()
    }
    const empty = await readAndValidateManifest(
      tempManifest({ ...validHost, hostApp: { ...validHost.hostApp, hostDir: '' } }),
    )
    expect(empty?.hostApp?.hostDir).toBeUndefined() // 空串 = 未提供
  })

  it('hostApp hostBin 越界（.. / 绝对路径）拒绝', async () => {
    for (const bin of ['../escape.js', '/etc/passwd', 'a b']) {
      const m = await readAndValidateManifest(
        tempManifest({ ...validHost, hostApp: { ...validHost.hostApp, hostBin: bin } }),
      )
      expect(m, `hostBin=${bin}`).toBeNull()
    }
  })

  it('hostApp env 名非法拒绝', async () => {
    const m = await readAndValidateManifest(
      tempManifest({ ...validHost, hostApp: { ...validHost.hostApp, dataHomeEnv: 'lower-case' } }),
    )
    expect(m).toBeNull()
  })

  it('webComponent 缺 tag/entry 拒绝', async () => {
    const m = await readAndValidateManifest(tempManifest({ id: 'x', name: 'X', slot: 'content' }))
    expect(m).toBeNull()
  })
})

describe('findManifestDir（zip 导入解压后找插件目录）', () => {
  it('manifest 在压缩包根目录', async () => {
    const dir = tempManifest(validWeb)
    expect(await findManifestDir(dir)).toBe(dir)
  })

  it('manifest 在一层子目录（外层套一个文件夹）能找到', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-find-'))
    dirs.push(dir)
    const nested = join(dir, 'demo-host')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'manifest.json'), JSON.stringify(validWeb))
    expect(await findManifestDir(dir)).toBe(nested)
  })

  it('manifest 层级过深（>1 层）不支持，返回 null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-find-'))
    dirs.push(dir)
    const nested = join(dir, 'outer', 'plugins', 'demo-host')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'manifest.json'), JSON.stringify(validWeb))
    expect(await findManifestDir(dir)).toBeNull()
  })

  it('无 manifest 返回 null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-find-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    expect(await findManifestDir(dir)).toBeNull()
  })
})
