<script setup lang="ts">
import { computed, type Component } from 'vue'
import { store } from '../shell/store'
import PluginElement from './PluginElement.vue'
import HostAppView from '../shell/views/HostAppView.vue'
import PluginDetailView from '../shell/views/PluginDetailView.vue'

/** 壳层页面组件表（page id → 组件） */
const props = defineProps<{ pages: Record<string, Component> }>()

const view = computed(() => store.currentView)
const pageComp = computed<Component | undefined>(() =>
  view.value.type === 'page' ? props.pages[view.value.id] : undefined,
)
// 当前激活的 content 插件条目（供 PluginElement 渲染 + 生命周期）
const activePlugin = computed(() =>
  view.value.type === 'plugin' ? store.pluginItems.find((p) => p.id === view.value.id) : undefined,
)
// 详情页插件条目（双击插件行进入）
const detailPlugin = computed(() =>
  view.value.type === 'detail' ? store.pluginItems.find((p) => p.id === view.value.id) : undefined,
)
</script>

<template>
  <!-- 壳层页面（首页 / 插件管理 / 设置） -->
  <component :is="pageComp" v-if="pageComp" />
  <!-- 插件详情页（双击插件行进入） -->
  <PluginDetailView v-else-if="detailPlugin" :plugin="detailPlugin" />
  <!-- hostApp 插件（外部宿主应用侧车，如 dsh Agent）：WebContentsView 覆盖内容区 -->
  <HostAppView v-else-if="activePlugin && activePlugin.kind === 'hostApp'" :plugin="activePlugin" />
  <!-- 选中的 content 插件（经 PluginElement 驱动 onMount/onUnmount） -->
  <PluginElement v-else-if="activePlugin" :plugin="activePlugin" />
  <div v-else class="content-empty">未找到可显示的内容</div>
</template>

<style scoped>
.content-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}
</style>
