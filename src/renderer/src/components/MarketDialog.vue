<script setup lang="ts">
import { ref } from 'vue'
import { store } from '../shell/store'
import AppIcon from './AppIcon.vue'
import type { MarketPlugin, MarketSearchResult } from '@shared/market'

/**
 * 插件市场弹窗：独立搜索框，回车搜索市场数据并展示结果；点「安装」联网下载安装。
 * 未配置注册表（APP_MARKET_REGISTRY）时返回 available:false，显示"未开放"提示。
 */
const emit = defineEmits<{ (e: 'close'): void }>()

const query = ref('')
const result = ref<MarketSearchResult | null>(null)
const searching = ref(false)
const installing = ref(false)

async function onSearch(): Promise<void> {
  const q = query.value.trim()
  if (!q) return
  searching.value = true
  try {
    result.value = await store.searchMarket(q)
  } finally {
    searching.value = false
  }
}

async function onInstall(item: MarketPlugin): Promise<void> {
  if (installing.value) return
  installing.value = true
  try {
    await store.installMarketPlugin(item.id)
    window.alert(`插件「${item.name}」安装成功。可在「第三方插件」列表查看并启用。`)
    emit('close')
  } catch (err) {
    window.alert(`安装失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    installing.value = false
  }
}
</script>

<template>
  <div class="market-overlay" @click.self="$emit('close')">
    <div class="market-dialog" role="dialog" aria-modal="true" aria-label="插件市场">
      <header class="market-header">
        <h2 class="market-title">插件市场</h2>
        <button type="button" class="close-btn" aria-label="关闭" @click="$emit('close')">×</button>
      </header>

      <div class="market-search">
        <AppIcon name="search" :size="16" />
        <input
          v-model="query"
          type="search"
          placeholder="输入插件名称，回车搜索…"
          spellcheck="false"
          @keyup.enter="onSearch"
        />
        <button type="button" class="btn" :disabled="searching" @click="onSearch">
          {{ searching ? '搜索中…' : '搜索' }}
        </button>
      </div>

      <div class="market-body">
        <p v-if="!result" class="market-placeholder">
          输入插件名称后回车，从插件市场搜索并展示结果。
        </p>
        <p v-else-if="result.error" class="market-hint">{{ result.error }}</p>
        <p v-else-if="!result.available" class="market-hint">
          插件市场尚未开放，暂不能联网搜索与安装。
        </p>
        <div v-else class="market-list">
          <div v-for="m in result.items" :key="m.id" class="market-item">
            <div class="market-info">
              <span class="market-name">{{ m.name }}</span>
              <span class="market-version">{{ m.version }}</span>
              <span class="market-desc">{{ m.description }}</span>
            </div>
            <button type="button" class="btn" :disabled="installing" @click="onInstall(m)">
              {{ installing ? '安装中…' : '安装' }}
            </button>
          </div>
          <p v-if="!result.items.length" class="market-empty">
            没有找到匹配「{{ query }}」的插件。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.market-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(16, 20, 28, 0.45);
}
.market-dialog {
  width: 560px;
  max-width: calc(100vw - 64px);
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
}
.market-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4);
  border-bottom: 1px solid var(--border);
}
.market-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.close-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-xl);
  line-height: 1;
  cursor: pointer;
}
.close-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.market-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}
.market-search input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-base);
  background: var(--surface);
  color: var(--text);
  font-size: var(--font-size-sm);
}
.market-search input:focus {
  border-color: var(--accent);
  outline: 2px solid var(--focus-ring);
  outline-offset: -1px;
}
.btn {
  flex: none;
  height: 32px;
  padding: 0 var(--space-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-base);
  background: var(--surface);
  color: var(--text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
}
.btn:hover {
  background: var(--surface-2);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.market-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3);
}
.market-placeholder,
.market-hint,
.market-empty {
  margin: var(--space-6) 0;
  text-align: center;
  color: var(--text-muted);
}
.market-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.market-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.market-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.market-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
}
.market-version {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.market-desc {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
