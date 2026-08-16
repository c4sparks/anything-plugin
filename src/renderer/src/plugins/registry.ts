import { defineCustomElement, type ComponentPublicInstance } from 'vue'
import type { AppPlugin } from './types'

/**
 * 注册表：define + register/unregister 执行器。
 * 元数据快照由 shell/store.ts 反应式持有，UI 不直接读本表（Map 非响应式）。
 */
const plugins = new Map<string, AppPlugin>()

/** 可由 defineCustomElement 包装的组件：SFC 默认导出（DefineComponent）即满足 */
export type VueElementComponent = new (...args: unknown[]) => ComponentPublicInstance

/** 注册插件。webComponent 需自定义元素已定义（否则跳过告警）；hostApp 无 tag 直接注册 */
export function registerPlugin(plugin: AppPlugin): boolean {
  if (plugin.kind === 'hostApp') {
    plugins.set(plugin.id, plugin)
    return true
  }
  if (!plugin.tag || !customElements.get(plugin.tag)) {
    console.warn(`[plugins] 自定义元素 <${plugin.tag}> 未定义，插件「${plugin.id}」将被跳过`)
    return false
  }
  plugins.set(plugin.id, plugin)
  return true
}

/** 注册内置宿主应用插件（kind 固定 hostApp，不走 customElements） */
export function registerHostAppPlugin(meta: Omit<AppPlugin, 'kind'>): boolean {
  return registerPlugin({ ...meta, kind: 'hostApp' })
}

/** 便捷注册：把 Vue SFC 包装为自定义元素并注册 */
export function registerVuePlugin(meta: AppPlugin, component: VueElementComponent): boolean {
  if (!meta.tag) {
    console.warn(`[plugins] Vue 插件「${meta.id}」缺少 tag，将被跳过`)
    return false
  }
  if (!customElements.get(meta.tag)) {
    customElements.define(meta.tag, defineCustomElement(component))
  }
  return registerPlugin(meta)
}

/** 注销插件（重扫时移除已删除的外部插件用） */
export function unregisterPlugin(id: string): boolean {
  return plugins.delete(id)
}

/** 取全部已注册插件（不含 enabled 过滤；过滤在 store 层） */
export function getPlugins(): AppPlugin[] {
  return [...plugins.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
