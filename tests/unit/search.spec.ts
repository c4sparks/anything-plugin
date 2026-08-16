import { describe, it, expect } from 'vitest'
import { pluginMatches, firstHitKeyword } from '../../src/renderer/src/shell/search'

const demo = { name: '时钟', id: 'demo-clock', description: '实时时间展示' }

describe('pluginMatches（多关键词/拼音/子串）', () => {
  it('多关键词空格分词：全中才命中（AND）', () => {
    expect(pluginMatches(demo, '时钟 demo')).toBe(true)
    expect(pluginMatches(demo, '时钟 便签')).toBe(false)
  })

  it('中文名可打全拼匹配', () => {
    expect(pluginMatches(demo, 'shizhong')).toBe(true)
  })

  it('中文名可打首字母匹配', () => {
    expect(pluginMatches(demo, 'sz')).toBe(true)
  })

  it('原文大小写不敏感子串匹配', () => {
    expect(pluginMatches(demo, '实时')).toBe(true)
    expect(pluginMatches(demo, 'CLOCK')).toBe(true)
    expect(pluginMatches(demo, 'time')).toBe(false)
  })

  it('空/纯空格关键词全部命中', () => {
    expect(pluginMatches(demo, '')).toBe(true)
    expect(pluginMatches(demo, '   ')).toBe(true)
  })
})

describe('firstHitKeyword（多关键词高亮第一个命中）', () => {
  it('返回查询里第一个命中的关键词', () => {
    expect(firstHitKeyword('Demo Host', 'host demo')).toBe('host')
    expect(firstHitKeyword('Demo Host', 'demo host')).toBe('demo')
  })
  it('无命中返回 null', () => {
    expect(firstHitKeyword('Demo Host', 'zzz')).toBeNull()
  })
})
