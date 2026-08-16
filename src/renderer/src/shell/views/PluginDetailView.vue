<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { store } from '../store'
import AppIcon from '../../components/AppIcon.vue'
import type { PluginItem } from '../../plugins/types'
import type { PluginDetail } from '@shared/plugins'
import type { HostAppIcon } from '@shared/hostApp'
import type { AgentStatus } from '@shared/agent'

/**
 * 插件详情页（类 VS Code 扩展详情）：双击插件行进入。
 * 布局：左列 = 描述 + README 正文；右列 = 元信息面板（类型/来源/主页/仓库/许可证/标签/依赖）。
 * 数据按需拉取 `plugins:detail(id)`（完整 manifest + README/CHANGELOG.md）。
 * README 为 Markdown，渲染前必须 DOMPurify sanitize（第三方插件作者的 Markdown 不可信）。
 */
const props = defineProps<{ plugin: PluginItem }>()

const detail = ref<PluginDetail | null>(null)
const loading = ref(true)
const error = ref('')

onMounted(async () => {
  try {
    detail.value = await window.api.plugins.detail(props.plugin.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})

/** Markdown → sanitized HTML（防 XSS：第三方插件作者的内容不可信） */
function markdownHtml(md: string): string {
  if (!md) return ''
  const html = marked.parse(md)
  return DOMPurify.sanitize(typeof html === 'string' ? html : '')
}

/** README markdown → sanitized HTML */
const readmeHtml = computed(() => markdownHtml(detail.value?.readme ?? ''))

function hostAppStatus(s: AgentStatus): string {
  if (s === 'ready') return '运行中'
  if (s === 'starting') return '启动中'
  if (s === 'error') return '启动失败'
  if (s === 'stopped') return '已停止'
  return '未启动'
}

const isUpgrading = computed(() => store.upgradeStates[props.plugin.id]?.phase === 'installing')

function pluginIcon(): HostAppIcon {
  return (props.plugin.iconName as HostAppIcon | undefined) ?? 'plugin'
}

function onUninstall(): void {
  if (
    !window.confirm(
      `确定卸载插件「${props.plugin.name}」？将删除其插件目录/数据，${
        props.plugin.source === 'builtin'
          ? '内置 dsh 可在插件页重新安装。'
          : '需重新放回插件目录才能恢复。'
      }`,
    )
  ) {
    return
  }
  if (props.plugin.kind === 'hostApp') void store.uninstallHostApp(props.plugin.id)
  else void store.uninstallPlugin(props.plugin.id)
}
</script>

<template>
  <div class="plugin-detail">
    <div class="pd-nav">
      <button type="button" class="btn" @click="store.navigatePage('plugins')">
        <AppIcon name="chevron" :size="14" flip />
        <span>返回插件列表</span>
      </button>
    </div>

    <!-- 头部（精简，不像列表行）：图标 + 名称/版本 + 操作按钮 -->
    <header class="pd-header">
      <AppIcon v-if="plugin.kind === 'hostApp'" :name="pluginIcon()" :size="32" class="pd-icon" />
      <AppIcon v-else-if="!plugin.icon" name="plugin" :size="32" class="pd-icon" />
      <img v-else :src="plugin.icon" alt="" class="pd-img" />

      <div class="pd-headinfo">
        <h1 class="pd-name">{{ plugin.name }}</h1>
        <p class="pd-ver">
          <template v-if="plugin.kind === 'hostApp'">
            {{ store.updateInfos[plugin.id] ? `v${store.updateInfos[plugin.id].current}` : '' }}
          </template>
          <template v-else>{{ plugin.version ?? '—' }}</template>
        </p>
      </div>

      <div class="pd-actions">
        <button
          v-if="plugin.enabled && (plugin.kind === 'hostApp' || plugin.slot === 'content')"
          type="button"
          class="icon-btn"
          title="打开"
          @click="store.navigatePlugin(plugin.id)"
        >
          <AppIcon name="open" :size="16" />
        </button>
        <template v-if="plugin.kind === 'hostApp'">
          <button
            v-if="store.agentStateOf(plugin.id).status === 'ready'"
            type="button"
            class="icon-btn"
            title="停止"
            :disabled="!plugin.enabled"
            @click="store.stopAgent(plugin.id)"
          >
            <AppIcon name="stop" :size="16" />
          </button>
          <button
            v-else-if="store.agentStateOf(plugin.id).status !== 'starting'"
            type="button"
            class="icon-btn"
            title="启动"
            :disabled="!plugin.enabled"
            @click="store.startAgent(plugin.id)"
          >
            <AppIcon name="play" :size="16" />
          </button>
          <button
            v-if="store.updateInfos[plugin.id]?.hasUpdate && store.updateInfos[plugin.id].latest && !isUpgrading"
            type="button"
            class="icon-btn accent"
            title="升级"
            @click="store.upgradeAgent(plugin.id, store.updateInfos[plugin.id].latest!)"
          >
            <AppIcon name="upgrade" :size="16" />
          </button>
          <button
            type="button"
            class="icon-btn"
            :disabled="store.checkingIds[plugin.id] || isUpgrading"
            :title="store.checkingIds[plugin.id] ? '检查中…' : '检查更新'"
            @click="store.checkAgentUpdate(plugin.id)"
          >
            <AppIcon name="refresh" :size="16" />
          </button>
        </template>
        <button
          v-if="plugin.source === 'external' || plugin.kind === 'hostApp'"
          type="button"
          class="icon-btn danger"
          title="卸载"
          @click="onUninstall"
        >
          <AppIcon name="trash" :size="16" />
        </button>
        <button
          type="button"
          class="icon-btn"
          :class="{ active: plugin.enabled }"
          :title="plugin.enabled ? '禁用' : '启用'"
          @click="store.togglePlugin(plugin.id)"
        >
          <AppIcon name="power" :size="16" />
        </button>
      </div>
    </header>

    <!-- 主体：左 = README 正文；右 = 元信息面板（含描述） -->
    <div class="pd-body">
      <div class="pd-main">
        <div class="pd-readme">
          <div v-if="loading" class="pd-hint">加载详情…</div>
          <div v-else-if="error" class="pd-hint error">{{ error }}</div>
          <div v-else-if="readmeHtml" class="markdown" v-html="readmeHtml"></div>
          <div v-else class="pd-hint">该插件没有提供 README。</div>
        </div>
      </div>

      <aside class="pd-side">
        <div v-if="plugin.description" class="pd-side-desc">{{ plugin.description }}</div>
        <div v-if="plugin.kind === 'hostApp'" class="pd-side-item">
          <span class="pd-k">状态</span>
          <span :class="`st-${store.agentStateOf(plugin.id).status}`">
            {{ hostAppStatus(store.agentStateOf(plugin.id).status) }}
          </span>
        </div>
        <div
          v-if="plugin.kind === 'hostApp' && plugin.tier === 'thirdParty'"
          class="pd-side-item warn"
        >
          <span class="pd-k">安全</span>
          <span>独立程序</span>
        </div>
        <div
          v-if="plugin.tier === 'thirdParty' && plugin.kind !== 'hostApp'"
          class="pd-side-item"
        >
          <span class="pd-k">安全</span>
          <span>沙箱运行</span>
        </div>
        <div class="pd-side-item">
          <span class="pd-k">类型</span>
          <span>{{ plugin.kind === 'hostApp' ? 'hostApp' : 'webComponent' }}</span>
        </div>
        <div class="pd-side-item">
          <span class="pd-k">来源</span>
          <span>{{ plugin.source === 'external' ? '外部' : '内置' }}</span>
        </div>
        <div class="pd-side-item">
          <span class="pd-k">主页</span>
          <a v-if="plugin.homepage" :href="plugin.homepage" target="_blank" rel="noreferrer">↗</a>
          <span v-else>—</span>
        </div>
        <div class="pd-side-item">
          <span class="pd-k">仓库</span>
          <a v-if="plugin.repository" :href="plugin.repository" target="_blank" rel="noreferrer">↗</a>
          <span v-else>—</span>
        </div>
        <div class="pd-side-item">
          <span class="pd-k">许可证</span>
          <span>{{ plugin.license ?? '—' }}</span>
        </div>
        <div class="pd-side-item">
          <span class="pd-k">标签</span>
          <span>{{ plugin.tags?.length ? plugin.tags.join(', ') : '—' }}</span>
        </div>
        <div class="pd-side-item" v-if="plugin.dependencies?.length">
          <span class="pd-k">依赖</span>
          <span>{{ plugin.dependencies.join(', ') }}</span>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.plugin-detail {
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.pd-nav .btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 30px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-base);
  background: var(--surface);
  color: var(--text);
  font-size: var(--font-size-sm);
  cursor: pointer;
}
.pd-nav .btn:hover {
  background: var(--surface-2);
}
.pd-header {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.pd-icon {
  flex: none;
  color: var(--accent);
}
.pd-img {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-base);
}
.pd-headinfo {
  flex: 1;
  min-width: 0;
}
.pd-name {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
}
.pd-ver {
  margin: var(--space-1) 0 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}
.pd-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}

/* 主体：左列 + 右列元信息 */
.pd-body {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}
.pd-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.pd-readme {
  padding: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow-x: auto;
}
.pd-hint {
  text-align: center;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  padding: var(--space-6) 0;
}
.pd-hint.error {
  color: var(--danger);
}

/* 右列元信息面板 */
.pd-side {
  flex: none;
  width: 220px;
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pd-side-desc {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.5;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.pd-side-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--text);
}
.pd-side-item.warn {
  color: var(--danger);
}
.pd-side-item .st-ready {
  color: var(--success);
}
.pd-side-item .st-starting {
  color: var(--accent);
}
.pd-side-item .st-error {
  color: var(--danger);
}
.pd-k {
  width: 52px;
  flex: none;
  color: var(--text-muted);
}
.pd-side-item a {
  color: var(--accent);
  text-decoration: none;
}
.pd-side-item a:hover {
  text-decoration: underline;
}

.icon-btn {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.icon-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.icon-btn.active,
.icon-btn.accent {
  color: var(--accent);
}
.icon-btn.danger:hover {
  color: var(--danger);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
.badge.safe-on {
  background: var(--surface-2);
  color: var(--success);
}
.badge.host-app {
  background: var(--surface-2);
  color: var(--accent);
}
.badge.host-warn {
  background: var(--danger);
  color: #fff;
}

/* README Markdown 基础样式 */
.markdown {
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--text);
  overflow-wrap: anywhere;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3) {
  margin: var(--space-4) 0 var(--space-2);
  line-height: 1.3;
}
.markdown :deep(h1:first-child),
.markdown :deep(h2:first-child) {
  margin-top: 0;
}
.markdown :deep(p) {
  margin: var(--space-2) 0;
}
.markdown :deep(ul),
.markdown :deep(ol) {
  margin: var(--space-2) 0;
  padding-left: var(--space-4);
}
.markdown :deep(code) {
  padding: 1px var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: 0.9em;
}
.markdown :deep(pre) {
  padding: var(--space-3);
  border-radius: var(--radius-base);
  background: var(--surface-2);
  overflow-x: auto;
}
.markdown :deep(pre code) {
  background: transparent;
  padding: 0;
}
.markdown :deep(a) {
  color: var(--accent);
}
.markdown :deep(blockquote) {
  margin: var(--space-2) 0;
  padding-left: var(--space-3);
  border-left: 2px solid var(--border-strong);
  color: var(--text-muted);
}
</style>
