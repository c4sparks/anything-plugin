import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 每个 spec 独立 userData（工厂内生成一次，稳定可复用），避免与其它测试文件并行写同一 tmpdir 互相干扰
vi.mock('electron', () => {
  const userData = join(tmpdir(), 'pd-spec-' + Math.random().toString(36).slice(2))
  return { app: { getPath: () => userData } }
})

import {
  clearPluginData,
  getPluginData,
  pluginDataDir,
  pluginDataRoot,
  removePluginData,
  setPluginData,
  PLUGIN_DATA_KEY_RE,
} from '../../src/main/pluginData'

afterEach(() => {
  rmSync(pluginDataRoot(), { recursive: true, force: true })
})

describe('plugin-data 读写', () => {
  it('set → get 往返，数据落在 userData/plugin-data/<id>/data.json', async () => {
    await setPluginData('t-roundtrip', 'text', '你好，产品级便签')
    expect(await getPluginData('t-roundtrip', 'text')).toBe('你好，产品级便签')
    const file = join(pluginDataDir('t-roundtrip'), 'data.json')
    expect(existsSync(file)).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>
    expect(onDisk['text']).toBe('你好，产品级便签')
  })

  it('读取不存在的 key 返回 null', async () => {
    expect(await getPluginData('t-missing', 'nope')).toBeNull()
  })

  it('remove 删除单个 key（不存在幂等）', async () => {
    await setPluginData('t-remove', 'a', '1')
    await setPluginData('t-remove', 'b', '2')
    await removePluginData('t-remove', 'a')
    expect(await getPluginData('t-remove', 'a')).toBeNull()
    expect(await getPluginData('t-remove', 'b')).toBe('2')
    await removePluginData('t-remove', 'a') // 幂等
  })

  it('clear 删除整个插件数据目录', async () => {
    await setPluginData('t-clear', 'text', 'v')
    expect(existsSync(pluginDataDir('t-clear'))).toBe(true)
    await clearPluginData('t-clear')
    expect(existsSync(pluginDataDir('t-clear'))).toBe(false)
    expect(await getPluginData('t-clear', 'text')).toBeNull()
  })

  it('并发写入不丢数据（串行队列）', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => setPluginData('t-conc', `k${i}`, `v${i}`)),
    )
    for (let i = 0; i < 20; i++) {
      expect(await getPluginData('t-conc', `k${i}`)).toBe(`v${i}`)
    }
  })

  it('数据文件损坏时按空对象处理，写入即重建', async () => {
    const dir = pluginDataDir('t-corrupt')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'data.json'), '{broken json', 'utf-8')
    expect(await getPluginData('t-corrupt', 'x')).toBeNull()
    await setPluginData('t-corrupt', 'x', 'ok')
    expect(await getPluginData('t-corrupt', 'x')).toBe('ok')
  })
})

describe('plugin-data 校验', () => {
  it('现有 demo 数据 key 均符合白名单（防回归）', () => {
    expect(PLUGIN_DATA_KEY_RE.test('text')).toBe(true)
    expect(PLUGIN_DATA_KEY_RE.test('greetcount')).toBe(true)
    expect(PLUGIN_DATA_KEY_RE.test('greetCount')).toBe(false) // 大写被拒
  })

  it('非法插件 id 拒绝（目录穿越/大写/空/超长）', async () => {
    const bad = ['../evil', 'UPPER', 'has space', '', 'a'.repeat(65)]
    for (const id of bad) {
      await expect(getPluginData(id, 'k')).rejects.toThrow('无效的插件 id')
      await expect(setPluginData(id, 'k', 'v')).rejects.toThrow('无效的插件 id')
      await expect(clearPluginData(id)).rejects.toThrow('无效的插件 id')
    }
  })

  it('非法 key 拒绝（大写/路径/空格/超长）', async () => {
    const bad = ['Upper', '../x', 'a b', 'a'.repeat(65)]
    for (const key of bad) {
      await expect(getPluginData('t-key', key)).rejects.toThrow('无效的数据 key')
      await expect(setPluginData('t-key', key, 'v')).rejects.toThrow('无效的数据 key')
      await expect(removePluginData('t-key', key)).rejects.toThrow('无效的数据 key')
    }
  })

  it('value 超长拒绝（>512KB）', async () => {
    await expect(setPluginData('t-size', 'k', 'x'.repeat(512 * 1024 + 1))).rejects.toThrow(
      '数据值必须是',
    )
  })

  it('非字符串 value 拒绝', async () => {
    await expect(setPluginData('t-type', 'k', 42 as unknown as string)).rejects.toThrow(
      '数据值必须是',
    )
  })
})
