import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 每个 spec 独立 userData（mock 工厂内生成一次），避免并行干扰
vi.mock('electron', () => {
  const userData = join(tmpdir(), 'pf-spec-' + Math.random().toString(36).slice(2))
  return { app: { getPath: () => userData } }
})

import {
  copyPluginFile,
  listPluginFiles,
  mkPluginDir,
  movePluginFile,
  pluginFilesRoot,
  readPluginFile,
  removePluginFile,
  writePluginFile,
} from '../../src/main/pluginFiles'

afterEach(() => {
  rmSync(join(pluginFilesRoot('cleanup'), '..', '..'), { recursive: true, force: true })
})

describe('plugin-files 读写', () => {
  it('write → read 往返（自动建父目录）', async () => {
    await writePluginFile('t-notes', 'folder/a.md', '# 你好')
    expect(await readPluginFile('t-notes', 'folder/a.md')).toBe('# 你好')
  })

  it('list 返回文件/文件夹，文件夹在前、名称排序', async () => {
    await writePluginFile('t-list', 'b.md', 'b')
    await writePluginFile('t-list', 'a.md', 'a')
    await mkPluginDir('t-list', 'folder')
    await writePluginFile('t-list', 'folder/c.md', 'c')
    const root = await listPluginFiles('t-list')
    expect(root.map((e) => e.name)).toEqual(['folder', 'a.md', 'b.md'])
    expect(root[0].isDirectory).toBe(true)
    const sub = await listPluginFiles('t-list', 'folder')
    expect(sub.map((e) => e.name)).toEqual(['c.md'])
    // 契约：相对路径统一正斜杠（`a/b.md`），跨平台一致（Windows path.join 会产生反斜杠）
    expect(root[0].path).toBe('folder')
    expect(sub[0].path).toBe('folder/c.md')
  })

  it('list 返回 createdMs（创建时间）', async () => {
    await writePluginFile('t-created', 'a.md', 'a')
    const [file] = await listPluginFiles('t-created')
    expect(file.createdMs).toBeGreaterThan(0)
  })

  it('remove 删除文件与文件夹（递归）', async () => {
    await writePluginFile('t-rm', 'a.md', 'a')
    await writePluginFile('t-rm', 'folder/b.md', 'b')
    await removePluginFile('t-rm', 'a.md')
    await expect(readPluginFile('t-rm', 'a.md')).rejects.toThrow()
    await removePluginFile('t-rm', 'folder')
    expect((await listPluginFiles('t-rm')).length).toBe(0)
  })

  it('原子写不留 .tmp 残留', async () => {
    await writePluginFile('t-atomic', 'x.md', 'v')
    expect(existsSync(join(pluginFilesRoot('t-atomic'), 'x.md'))).toBe(true)
    expect(existsSync(join(pluginFilesRoot('t-atomic'), 'x.md.tmp'))).toBe(false)
  })

  it('copy 复制文件与文件夹（递归）', async () => {
    await writePluginFile('t-copy', 'a.md', '# A')
    await writePluginFile('t-copy', 'dir/b.md', '# B')
    await copyPluginFile('t-copy', 'a.md', 'a2.md')
    await copyPluginFile('t-copy', 'dir', 'dir2')
    expect(await readPluginFile('t-copy', 'a2.md')).toBe('# A')
    expect(await readPluginFile('t-copy', 'dir2/b.md')).toBe('# B')
    // 目标已存在报错
    await expect(copyPluginFile('t-copy', 'a.md', 'a2.md')).rejects.toThrow()
  })

  it('move 移动/重命名文件与文件夹', async () => {
    await writePluginFile('t-move', 'a.md', '# A')
    await writePluginFile('t-move', 'dir/b.md', '# B')
    await movePluginFile('t-move', 'a.md', 'dir/a.md')
    await movePluginFile('t-move', 'dir', 'renamed')
    expect(await readPluginFile('t-move', 'renamed/a.md')).toBe('# A')
    expect(await readPluginFile('t-move', 'renamed/b.md')).toBe('# B')
    await expect(readPluginFile('t-move', 'a.md')).rejects.toThrow()
  })
})

describe('plugin-files 校验', () => {
  it('非法插件 id 拒绝', async () => {
    await expect(readPluginFile('../evil', 'a.md')).rejects.toThrow('无效的插件 id')
    await expect(writePluginFile('UPPER', 'a.md', 'x')).rejects.toThrow('无效的插件 id')
  })

  it('非法相对路径拒绝（穿越/绝对/空白/空段/点/冒号/超长）', async () => {
    const bad = ['../x', '/abs', 'a b', 'a//b', 'a/../b', '.', 'a:b', 'x'.repeat(257)]
    for (const p of bad) {
      await expect(readPluginFile('t-p', p)).rejects.toThrow('无效的文件路径')
      await expect(writePluginFile('t-p', p, 'x')).rejects.toThrow('无效的文件路径')
      await expect(removePluginFile('t-p', p)).rejects.toThrow('无效的文件路径')
    }
  })

  it('内容超限（>1MB）拒绝', async () => {
    await expect(writePluginFile('t-size', 'big.md', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow(
      '文件内容必须是',
    )
  })
})
