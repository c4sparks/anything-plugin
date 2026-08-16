<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../store'
import type { PluginItem } from '../../plugins/types'

/** hostApp 插件内容占位：启动/错误态显示文本，就绪时留空（WebContentsView 覆盖其上） */
const props = defineProps<{ plugin: PluginItem }>()

/** 该宿主应用运行时状态 */
const state = computed(() => store.agentStateOf(props.plugin.id))

/** 启动宿主应用（从错误/停止态重试） */
async function onStart(): Promise<void> {
  await store.startAgent(props.plugin.id)
}
</script>

<template>
  <div class="hostapp-view">
    <p v-if="state.status === 'starting'" class="state">{{ props.plugin.name }} 启动中…</p>
    <p v-else-if="state.status === 'error'" class="state error">
      {{ props.plugin.name }} 启动失败：{{ state.error }}
    </p>
    <p v-else-if="state.status === 'idle' || state.status === 'stopped'" class="state">
      {{ props.plugin.name }} 未运行。
      <button type="button" class="btn" @click="onStart">启动</button>
    </p>
    <!-- ready：内容区由 WebContentsView 覆盖，这里留空 -->
    <p v-else class="state hint">{{ props.plugin.name }} 已就绪（{{ state.url }}）</p>
  </div>
</template>

<style scoped>
.hostapp-view {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.state {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}
.state.error {
  color: var(--danger);
}
.state.hint {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}
.btn {
  height: 30px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-base);
  background: var(--surface);
  color: var(--text);
  font-size: var(--font-size-sm);
  cursor: pointer;
}
.btn:hover {
  background: var(--surface-2);
}
</style>
