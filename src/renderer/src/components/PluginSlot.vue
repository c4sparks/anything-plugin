<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../shell/store'
import PluginElement from './PluginElement.vue'

const props = defineProps<{ name: string }>()

// 当前槽位下启用且按 order 排序的插件（数据源：反应式 store）
const items = computed(() => store.pluginsForSlot(props.name))
</script>

<template>
  <template v-for="p in items" :key="p.id">
    <PluginElement :plugin="p" />
  </template>
</template>
