<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '../../components/AppIcon.vue'
import { store } from '../store'
import type { HostAppIcon } from '@shared/hostApp'

const total = computed(() => store.pluginItems.length)
const enabled = computed(() => store.pluginItems.filter((p) => p.enabled).length)
const failed = computed(() => store.pluginItems.filter((p) => p.status === 'error').length)
</script>

<template>
  <div class="home">
    <section class="hero">
      <div class="hero-text">
        <h1 class="hero-title">插件化桌面应用壳</h1>
        <p class="hero-lead">应用壳承载窗口与布局，扩展功能以 Web Component 插件挂载到槽位。</p>
      </div>
      <div class="hero-stats" aria-label="概览统计">
        <div class="stat">
          <span class="stat-value">{{ total }}</span>
          <span class="stat-label">插件</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ enabled }}</span>
          <span class="stat-label">已启用</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ failed }}</span>
          <span class="stat-label">加载失败</span>
        </div>
      </div>
    </section>

    <section>
      <h2 class="section-title">插件概览</h2>
      <div v-if="store.pluginItems.length" class="cards">
        <button
          v-for="p in store.pluginItems"
          :key="p.id"
          type="button"
          class="card"
          :class="{ disabled: !p.enabled }"
          @click="p.enabled ? store.navigatePlugin(p.id) : store.navigatePage('plugins')"
        >
          <div class="card-head">
            <span class="card-name">
              <AppIcon
                v-if="p.kind === 'hostApp'"
                :name="(p.iconName as HostAppIcon) ?? 'plugin'"
                :size="14"
                class="card-ic"
              />
              <AppIcon v-else-if="!p.icon" name="plugin" :size="14" class="card-ic" />
              <img v-else :src="p.icon" alt="" class="card-icon" />
              {{ p.name }}
            </span>
            <span class="badge" :class="p.source">{{
              p.source === 'external' ? '外部' : '内置'
            }}</span>
          </div>
          <p class="card-desc">{{ p.description || '暂无描述' }}</p>
          <div class="card-meta">
            <span>{{ p.version ?? '—' }}</span>
            <span v-if="p.status === 'error'" class="error-text">加载失败</span>
            <span v-else class="dot" :class="{ off: !p.enabled }">{{
              p.enabled ? '已启用' : '已禁用'
            }}</span>
          </div>
        </button>
      </div>
      <div v-else class="empty">
        <p>还没有可用的插件。</p>
        <p class="empty-hint">将插件包放入插件目录后，到「插件」页点「重新扫描」。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  max-width: 720px;
  margin: 0 auto;
}

/* 紧凑欢迎条（标题只在标题栏出现一次，这里不再重复应用名） */
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-lg);
}
.hero-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-tight);
}
.hero-lead {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}
.hero-stats {
  display: flex;
  gap: var(--space-4);
  flex: none;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
.stat-value {
  font-family: var(--font-mono);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.stat-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.section-title {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-3);
}
.card {
  padding: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}
.card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-1);
}
.card.disabled {
  opacity: 0.55;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.card-name {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
}
.card-ic {
  flex: none;
}
.card-icon {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
}
.card-desc {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  min-height: 2.6em;
}
.card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.dot {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.dot::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}
.dot.off::before {
  background: var(--border-strong);
}
.error-text {
  color: var(--danger);
}

.badge {
  padding: 1px var(--space-2);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
}
.badge.external {
  background: var(--accent);
  color: var(--accent-text);
}
.badge.builtin {
  background: var(--surface-2);
  color: var(--text-muted);
}

.empty {
  padding: var(--space-6);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  text-align: center;
  color: var(--text-muted);
}
.empty p {
  margin: 0;
}
.empty-hint {
  margin-top: var(--space-2);
  font-size: var(--font-size-sm);
}
</style>
