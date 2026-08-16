<script setup lang="ts">
import { getCurrentInstance, onBeforeUnmount, onMounted } from 'vue'
import type { PluginItem, PluginLifecycleElement } from '../plugins/types'

/**
 * 插件元素包裹组件：渲染 <app-plugin-*> 并驱动生命周期钩子。
 * - 挂载后调用 `el.onMount?.({ plugin })`
 * - 移除前调用 `el.onUnmount?.()`
 * 通过组件根元素 `$el`（即自定义元素 DOM 节点）调用，比模板 ref 在动态
 * `<component :is="string">` 上更可靠（生产构建下模板 ref 可能为 null）。
 */
const props = defineProps<{ plugin: PluginItem }>()
const inst = getCurrentInstance()

function el(): PluginLifecycleElement | null {
  return (inst?.proxy?.$el ?? null) as PluginLifecycleElement | null
}

onMounted(() => {
  el()?.onMount?.({ plugin: props.plugin })
})

onBeforeUnmount(() => {
  el()?.onUnmount?.()
})
</script>

<template>
  <!-- :is 为字符串标签时，Vue 渲染为原生自定义元素 <app-plugin-*/>；hostApp 无 tag 已被 ContentHost 分流 -->
  <component :is="props.plugin.tag" v-if="props.plugin.tag" />
</template>
