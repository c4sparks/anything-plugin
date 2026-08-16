<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import AppIcon from './components/AppIcon.vue'
import PluginSlot from './components/PluginSlot.vue'
import ContentHost from './components/ContentHost.vue'
import HomeView from './shell/views/HomeView.vue'
import PluginsView from './shell/views/PluginsView.vue'
import SettingsView from './shell/views/SettingsView.vue'
import { store } from './shell/store'
import { useAgentGeometry } from './shell/agentGeometry'
import { DSH_HOST_APP, type HostAppIcon } from '@shared/hostApp'

const pages: Record<string, Component> = {
  home: HomeView,
  plugins: PluginsView,
  settings: SettingsView,
}

const collapsed = computed(() => store.settings.sidebarCollapsed)
const contentPlugins = computed(() => store.pluginsForSlot('content'))
const sidebarWidgets = computed(() => store.pluginsForSlot('sidebar'))

/** 状态栏内置 dsh Agent 状态文本（空则隐藏） */
const agentStatusText = computed(() => {
  const s = store.agentStateOf(DSH_HOST_APP.id)
  if (s.status === 'ready') return `Agent 就绪${s.port ? ` :${s.port}` : ''}`
  if (s.status === 'starting') return 'Agent 启动中…'
  if (s.status === 'error') return 'Agent 错误'
  if (s.status === 'stopped') return 'Agent 已停止'
  return ''
})

// 内容区几何上报 → hostApp WebContentsView 定位
useAgentGeometry()

// 导航切换 → 同步各 hostApp 视图可见性（进入 hostApp 已在 navigatePlugin 启动侧车）
watch(
  () => store.currentView,
  () => {
    for (const p of store.hostAppItems()) store.syncAgentVisible(p.id)
  },
)

// ---- 自绘标题栏（frame:false）：左侧应用图标 + 应用名，右侧窗口控制按钮 ----
const appIcon = ref('')
const isMaximized = ref(false)
let unsubscribeMaximized: (() => void) | null = null

onMounted(() => {
  void window.api.app.info().then((info) => {
    appIcon.value = info.iconDataUrl
  })
  void window.api.window.isMaximized().then((v) => (isMaximized.value = v))
  unsubscribeMaximized = window.api.window.onMaximizedChanged((v) => (isMaximized.value = v))
})
onBeforeUnmount(() => {
  unsubscribeMaximized?.()
})
function minimizeWindow(): void {
  window.api.window.minimize()
}
function toggleMaximizeWindow(): void {
  window.api.window.toggleMaximize()
}
function closeWindow(): void {
  window.api.window.close()
}
</script>

<template>
  <div class="shell">
    <!-- 自绘 44px 标题栏（frame:false）：左=应用图标 + 应用名，右=窗口控制按钮；整条可拖拽移动/吸附 -->
    <header class="titlebar">
      <div class="titlebar-brand">
        <img v-if="appIcon" :src="appIcon" class="titlebar-icon" alt="" draggable="false" />
        <span class="titlebar-title">AnythingPlugin</span>
      </div>
      <div class="window-controls">
        <button type="button" class="window-btn" title="最小化" @click="minimizeWindow">
          <svg viewBox="0 0 24 24" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
        <button
          type="button"
          class="window-btn"
          :title="isMaximized ? '还原' : '最大化'"
          @click="toggleMaximizeWindow"
        >
          <svg v-if="!isMaximized" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5.5" y="5.5" width="13" height="13" rx="1" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="9" width="10" height="10" rx="1" />
            <rect x="9" y="5" width="10" height="10" rx="1" />
          </svg>
        </button>
        <button type="button" class="window-btn window-close" title="关闭" @click="closeWindow">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </header>

    <div class="shell-body">
      <!-- 侧栏三段区域契约（docs/设计规范.md §3.1）：
           ① 顶部固定菜单区 activity-top：首页/插件等固定项，未来固定项追加到此处
           ② 中部插件追加区 sidebar-scroll：content 插件 / 小部件，新插件按 order 追加到此处
           ③ 底部工具区 sidebar-bottom：设置 / 折叠等，未来工具追加到此处 -->
      <aside class="sidebar" :class="{ collapsed }">
        <!-- ① 顶部固定菜单区 -->
        <nav class="activity-top" aria-label="主导航">
          <button
            type="button"
            class="activity-item"
            :class="{ active: store.isPageActive('home') }"
            title="首页"
            @click="store.navigatePage('home')"
          >
            <AppIcon name="home" />
            <span class="item-label">首页</span>
          </button>
          <button
            type="button"
            class="activity-item"
            :class="{ active: store.isPageActive('plugins') }"
            title="插件"
            @click="store.openPlugins()"
          >
            <AppIcon name="plugin" />
            <span class="item-label">插件</span>
          </button>
        </nav>

        <!-- ② 中部插件追加区 -->
        <div class="sidebar-scroll">
          <nav v-if="contentPlugins.length" class="sidebar-group" aria-label="已安装插件">
            <button
              v-for="p in contentPlugins"
              :key="p.id"
              type="button"
              class="slot-card"
              :class="{ active: store.isPluginActive(p.id) || store.pluginFocusId === p.id }"
              :title="p.name"
              @click="store.navigatePlugin(p.id)"
            >
              <AppIcon
                v-if="p.kind === 'hostApp'"
                :name="(p.iconName as HostAppIcon) ?? 'plugin'"
                :size="18"
              />
              <AppIcon v-else-if="!p.icon" name="plugin" :size="18" />
              <img v-else :src="p.icon" alt="" class="slot-icon" />
              <span class="item-label">{{ p.shortName || p.name }}</span>
            </button>
          </nav>

          <div v-if="sidebarWidgets.length && !collapsed" class="sidebar-group sidebar-widgets">
            <PluginSlot name="sidebar" />
          </div>
        </div>

        <!-- ③ 底部工具区 -->
        <div class="sidebar-bottom">
          <button
            type="button"
            class="activity-item"
            :class="{ active: store.isPageActive('settings') }"
            title="设置"
            @click="store.navigatePage('settings')"
          >
            <AppIcon name="gear" />
            <span class="item-label">设置</span>
          </button>
          <button
            type="button"
            class="activity-item collapse-btn"
            :title="collapsed ? '展开侧栏' : '折叠侧栏'"
            @click="store.toggleSidebar()"
          >
            <AppIcon name="panel" :flip="collapsed" />
            <span class="item-label">{{ collapsed ? '展开' : '折叠' }}</span>
          </button>
        </div>
      </aside>

      <main class="content">
        <ContentHost :pages="pages" />
      </main>
    </div>

    <footer class="statusbar">
      <span>就绪</span>
      <PluginSlot name="statusbar" />
      <span v-if="agentStatusText" class="statusbar-agent">{{ agentStatusText }}</span>
    </footer>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ---- 自绘标题栏（frame:false；左=应用名，右=窗口控制按钮；整条可拖拽移动/吸附） ---- */
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
  height: var(--titlebar-height);
  padding-left: var(--space-4);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}
.titlebar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.titlebar-icon {
  width: 32px;
  height: 32px;
  -webkit-app-region: no-drag;
}
.titlebar-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.01em;
}
/* 窗口控制按钮（no-drag 可点击，贴右缘） */
.window-controls {
  display: flex;
  align-self: stretch;
  -webkit-app-region: no-drag;
}
.window-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.window-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.window-btn svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.window-close:hover {
  background: var(--danger);
  color: #fff;
}

/* ---- 主体 ---- */
.shell-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* ---- 侧栏（展开 200px / 折叠 44px 图标栏） ---- */
.sidebar {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 200px;
  padding: var(--space-2);
  background: var(--surface);
  border-right: 1px solid var(--border);
  overflow: hidden;
  transition: width var(--duration-base) var(--ease-out);
}
.sidebar.collapsed {
  width: 44px;
  padding: var(--space-1);
}

/* 活动项与插件项：图标 + 名字（过长省略号，悬停 title 显全称） */
.activity-item,
.slot-card {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.activity-item {
  height: 36px;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  text-align: left;
}
.slot-card {
  height: 32px;
  color: var(--text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  text-align: left;
}
.item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slot-icon {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
}
.activity-item:hover,
.slot-card:hover {
  background: var(--surface-2);
  color: var(--text);
}
.activity-item.active {
  color: var(--accent);
  background: var(--surface-2);
}
.slot-card.active {
  color: var(--accent);
}

/* 折叠：只显示居中的完整图标 */
.sidebar.collapsed .activity-item,
.sidebar.collapsed .slot-card {
  justify-content: center;
  gap: 0;
  padding: 0;
}
.sidebar.collapsed .item-label {
  display: none;
}

.activity-top {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 中部：插件图标列表 + 小部件（无文字标签） */
.sidebar-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-3);
}
.sidebar.collapsed .sidebar-scroll {
  margin-top: 0;
}
.sidebar-group + .sidebar-group {
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
}
.sidebar-widgets {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 底部：设置 + 折叠开关 */
.sidebar-bottom {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: none;
  margin-top: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
}
.sidebar.collapsed .sidebar-bottom {
  margin-top: var(--space-2);
}
.collapse-btn {
  color: var(--text-muted);
}

/* ---- 内容区 ---- */
.content {
  flex: 1;
  padding: var(--space-4);
  overflow: auto;
}

/* ---- 状态栏 ---- */
.statusbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: none;
  height: var(--statusbar-height);
  padding: 0 var(--space-4);
  background: var(--surface);
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.statusbar-agent {
  color: var(--accent);
}
</style>
