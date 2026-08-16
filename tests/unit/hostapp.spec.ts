import { describe, it, expect } from 'vitest'
import { compileHostAppDef, DSH_HOST_APP } from '@shared/hostApp'

describe('compileHostAppDef', () => {
  it('把 manifest 的 hostApp（readyRe string）编译为运行时定义', () => {
    const def = compileHostAppDef(
      {
        packageName: '@scope/my-host',
        hostBin: 'lib/bin.js',
        cliArgs: ['--port', '0'],
        readyRe: 'my-host: http://127\\.0\\.0\\.1:(\\d+)',
        dataHomeEnv: 'MY_HOST_HOME',
        dataDir: 'my-host',
        runtimeDir: 'my-host-runtime',
        extraEnv: { FLAG: '1' },
      },
      { id: 'my-host', name: 'My Host', shortName: 'My', icon: 'box', description: 'desc' },
    )
    expect(def.id).toBe('my-host')
    expect(def.name).toBe('My Host')
    expect(def.shortName).toBe('My')
    expect(def.icon).toBe('box')
    expect(def.packageName).toBe('@scope/my-host')
    expect(def.cliArgs).toEqual(['--port', '0'])
    expect(def.readyRe).toBeInstanceOf(RegExp)
    expect(def.readyRe.exec('my-host: http://127.0.0.1:5555')?.[1]).toBe('5555')
    expect(def.extraEnv).toEqual({ FLAG: '1' })
  })

  it('缺省 shortName/icon 回退 name/plugin', () => {
    const def = compileHostAppDef(
      {
        packageName: 'x',
        hostBin: 'bin.js',
        cliArgs: [],
        readyRe: '(\\d+)',
        dataHomeEnv: 'X_HOME',
        dataDir: 'x',
        runtimeDir: 'x-runtime',
        extraEnv: {},
      },
      { id: 'x', name: 'X' },
    )
    expect(def.shortName).toBe('X')
    expect(def.icon).toBe('plugin')
    expect(def.description).toBe('')
  })

  it('hostDir 透传到运行时定义', () => {
    const def = compileHostAppDef(
      {
        packageName: 'demo-host',
        hostDir: '.',
        hostBin: 'lib/bin.js',
        cliArgs: ['--port', '0'],
        readyRe: 'demo-host: http://127\\.0\\.0\\.1:(\\d+)',
        dataHomeEnv: 'DEMO_HOST_HOME',
        dataDir: 'demo-host',
        runtimeDir: 'demo-host-runtime',
        extraEnv: {},
      },
      { id: 'demo-host', name: 'Demo Host' },
    )
    expect(def.hostDir).toBe('.')
  })

  it('内置 DSH_HOST_APP 的 readyRe 可匹配 dsh 就绪行', () => {
    const m = DSH_HOST_APP.readyRe.exec('dsh web: http://127.0.0.1:3080')
    expect(m?.[1]).toBe('3080')
  })
})
