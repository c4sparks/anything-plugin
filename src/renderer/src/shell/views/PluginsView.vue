<script setup lang="ts">
import { computed, h, nextTick, onMounted, ref, watch } from 'vue'
import { store } from '../store'
import AppIcon from '../../components/AppIcon.vue'
import MarketDialog from '../../components/MarketDialog.vue'
import type { PluginItem } from '../../plugins/types'
import { DSH_HOST_APP, type HostAppIcon } from '@shared/hostApp'
import type { AgentStatus } from '@shared/agent'
import { firstHitKeyword, pluginMatches } from '../search'
// ElMessage / ElMessageBox 由 unplugin-auto-import（ElementPlusResolver）自动引入

/** 内置 dsh 宿主应用定义（重装行显示用） */
const HOST_APP = DSH_HOST_APP

const query = ref('')
const scanning = ref(false)
const importing = ref(false)
/** 卸载确认框里「同时清除该插件数据」勾选状态（每次打开重置） */
const clearDataOnUninstall = ref(false)
/** 插件市场弹窗开关 */
const marketOpen = ref(false)
/** 插件市场尚未实现（功能清单 Q6 ◐），先隐藏入口按钮；实现后改为 true */
const marketEnabled = false

/** 指定宿主应用是否正在升级 */
function isUpgrading(id: string): boolean {
  return store.upgradeStates[id]?.phase === 'installing'
}

// 打开插件页时自动检查一次各宿主应用新版本（不重复）
onMounted(() => {
  for (const p of store.hostAppItems()) {
    if (!store.updateInfos[p.id]) void store.checkAgentUpdate(p.id)
  }
})

/** 统一列表：全部本地插件搜索匹配（多关键词/拼音/子串）；安全模式开启时隐藏第三方 */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return store.pluginItems.filter((p) => {
    if (store.settings.safeMode && p.tier === 'thirdParty') return false
    if (!q) return true
    return pluginMatches(p, query.value)
  })
})

/** hostApp 进程状态文案 */
function hostAppStatus(s: AgentStatus): string {
  if (s === 'ready') return '运行中'
  if (s === 'starting') return '启动中'
  if (s === 'error') return '启动失败'
  if (s === 'stopped') return '已停止'
  return '未启动'
}

async function onRescan(): Promise<void> {
  scanning.value = true
  try {
    await store.rescan()
    ElMessage.success('已重新扫描')
  } finally {
    scanning.value = false
  }
}

async function onImportLocal(): Promise<void> {
  importing.value = true
  try {
    const ok = await store.importLocal()
    if (ok) {
      ElMessage.success('已导入并重新扫描')
    }
    // 取消选择文件时 ok=false：不提示成功
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导入失败')
  } finally {
    importing.value = false
  }
}

async function onUninstall(p: PluginItem): Promise<void> {
  clearDataOnUninstall.value = false
  const message = h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, [
    h('p', { style: 'margin:0' }, `确定卸载插件「${p.name}」？其数据默认保留，重装可恢复。`),
    h(
      'label',
      {
        style:
          'display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;margin-top:2px',
      },
      [
        h('input', {
          type: 'checkbox',
          style: 'width:14px;height:14px;accent-color:var(--accent);cursor:pointer',
          onChange: (e: Event): void => {
            clearDataOnUninstall.value = (e.target as HTMLInputElement).checked
          },
        }),
        h('span', { style: 'font-size:var(--font-size-sm)' }, '同时清除该插件数据（plugin-data）'),
      ],
    ),
  ])
  try {
    await ElMessageBox.confirm(message, '卸载插件', {
      type: 'warning',
      confirmButtonText: '卸载',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await store.uninstallPlugin(p.id, clearDataOnUninstall.value)
  ElMessage.success(
    clearDataOnUninstall.value ? `已卸载「${p.name}」并清除其数据` : `已卸载「${p.name}」`,
  )
}

/** 卸载宿主应用（hostApp）：确认后停侧车 + 删数据/运行时（内置 dsh 可重新安装） */
async function onUninstallHostApp(p: PluginItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定卸载「${p.name}」？将停止并删除其数据与运行时目录，${p.source === 'builtin' ? '可在插件页重新安装。' : '需重新放回插件目录才能恢复。'}`,
      '卸载宿主应用',
      { type: 'warning', confirmButtonText: '卸载', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await store.uninstallHostApp(p.id)
  ElMessage.success(`已卸载「${p.name}」`)
}

/** 安全模式开关：点「开启」弹确认后开启（隐藏禁用第三方）；点「关闭」退出 */
async function onSafeMode(v: string | number | boolean): Promise<void> {
  const next = v === true
  if (next && !store.settings.safeMode) {
    try {
      await ElMessageBox.confirm('开启安全模式？第三方插件将被隐藏并禁用。', '安全模式', {
        type: 'warning',
        confirmButtonText: '开启',
        cancelButtonText: '取消',
      })
    } catch {
      return
    }
  }
  await store.setSafeMode(next)
}

/** 把命中关键词拆成 {text, hit} 片段，模板用 <mark> 高亮（多关键词只高亮最先命中的，不用 v-html 防注入） */
function highlightParts(text: string, q: string): { text: string; hit: boolean }[] {
  const kw = firstHitKeyword(text, q)
  if (!kw) return [{ text, hit: false }]
  const idx = text.toLowerCase().indexOf(kw)
  if (idx === -1) return [{ text, hit: false }]
  return [
    { text: text.slice(0, idx), hit: false },
    { text: text.slice(idx, idx + kw.length), hit: true },
    { text: text.slice(idx + kw.length), hit: false },
  ]
}

// 侧栏点插件 → 聚焦高亮并滚动到该行
watch(
  () => store.pluginFocusId,
  async (id) => {
    if (!id) return
    await nextTick()
    document.getElementById(`pm-${id}`)?.scrollIntoView({ block: 'nearest' })
  },
)
</script>

<template>
  <div class="plugins-view">
    <header class="pm-header">
      <div>
        <h1 class="view-title">插件</h1>
        <p class="view-sub">本地插件统一管理；内置随包分发，其余为外部安装。</p>
      </div>
      <div class="pm-actions">
        <el-button v-if="marketEnabled" size="small" @click="marketOpen = true">插件市场</el-button>
        <el-button size="small" :loading="importing" @click="onImportLocal">从本地安装</el-button>
        <el-button size="small" :loading="scanning" @click="onRescan">重新扫描</el-button>
      </div>
    </header>

    <div class="pm-toolbar">
      <el-input
        v-model="query"
        class="search-box"
        placeholder="搜索本地插件（名称 / id / 描述）…"
        clearable
        spellcheck="false"
      >
        <template #prefix><AppIcon name="search" :size="16" /></template>
      </el-input>
      <span class="pm-count">{{ filtered.length }} / {{ store.pluginItems.length }} 个插件</span>
      <!-- 安全模式（与搜索框同行右侧，开启时第三方插件隐藏禁用） -->
      <div
        class="safe-mode-toggle"
        :title="
          store.settings.safeMode
            ? '已开启：第三方插件已隐藏并禁用'
            : '未开启：第三方插件可见，可在沙箱中运行'
        "
      >
        <span class="safe-mode-text">安全模式</span>
        <el-switch :model-value="store.settings.safeMode" @update:model-value="onSafeMode" />
      </div>
    </div>

    <div class="pm-list">
      <!-- hostApp 已卸载：提供重新安装入口 -->
      <div v-if="!store.settings.agentInstalled" class="pm-row">
        <div class="pm-info">
          <div class="pm-line1">
            <AppIcon :name="HOST_APP.icon" :size="16" class="pm-ic" />
            <span class="pm-name">{{ HOST_APP.name }}</span>
            <span class="badge builtin">内置</span>
            <span class="badge host-app">hostApp</span>
            <span class="error-text">已卸载</span>
          </div>
          <p class="pm-line2">{{ HOST_APP.description }}</p>
        </div>
        <div class="pm-right">
          <el-button type="primary" size="small" @click="store.reinstallAgent()"
            >重新安装</el-button
          >
        </div>
      </div>

      <div
        v-for="p in filtered"
        :id="`pm-${p.id}`"
        :key="p.id"
        class="pm-row"
        :class="{ focus: store.pluginFocusId === p.id, off: !p.enabled }"
        @dblclick="store.openPluginDetail(p.id)"
      >
        <div class="pm-info">
          <!-- 第一行：图标 + 名称 + 内置/外部 + 类型徽标 -->
          <div class="pm-line1">
            <AppIcon
              v-if="p.kind === 'hostApp'"
              :name="(p.iconName as HostAppIcon) ?? 'plugin'"
              :size="16"
              class="pm-ic"
            />
            <AppIcon v-else-if="!p.icon" name="plugin" :size="16" class="pm-ic" />
            <img v-else :src="p.icon" alt="" class="pm-icon" />
            <span class="pm-name">
              <template v-for="(part, i) in highlightParts(p.name, query)" :key="i">
                <mark v-if="part.hit" class="hl">{{ part.text }}</mark
                ><template v-else>{{ part.text }}</template>
              </template>
            </span>
            <span class="badge" :class="p.source">{{
              p.source === 'external' ? '外部' : '内置'
            }}</span>
            <span v-if="p.kind === 'hostApp'" class="badge host-app">hostApp</span>
            <span v-if="p.kind === 'hostApp' && p.tier === 'thirdParty'" class="badge host-warn">
              独立程序
            </span>
            <span v-if="p.tier === 'thirdParty' && p.kind !== 'hostApp'" class="badge safe-on">
              沙箱运行
            </span>
            <span v-if="p.status === 'error'" class="error-text">加载失败</span>
          </div>
          <!-- 第二行：描述（可换行） -->
          <p class="pm-line2">
            <template v-for="(part, i) in highlightParts(p.description ?? '', query)" :key="i">
              <mark v-if="part.hit" class="hl">{{ part.text }}</mark
              ><template v-else>{{ part.text }}</template>
            </template>
          </p>
          <!-- 第三行：版本（hostApp 附 · hostApp；publisher 暂不展示；仅在有新版时提示升级） -->
          <p class="pm-line3">
            <template v-if="p.kind === 'hostApp'">
              {{ store.updateInfos[p.id] ? `v${store.updateInfos[p.id].current}` : '' }}
              · hostApp
              <span
                v-if="store.updateInfos[p.id]?.hasUpdate && store.updateInfos[p.id].latest"
                class="update-text new"
              >
                · 可升级至 {{ store.updateInfos[p.id].latest }}
              </span>
            </template>
            <template v-else>
              {{ p.version ?? '—' }}
              <template v-if="p.status === 'error'"> · {{ p.error }}</template>
            </template>
          </p>
        </div>

        <div class="pm-right">
          <!-- 运行状态（右侧） -->
          <span
            v-if="p.kind === 'hostApp'"
            class="pm-status"
            :class="`st-${store.agentStateOf(p.id).status}`"
          >
            {{ hostAppStatus(store.agentStateOf(p.id).status) }}
          </span>
          <span v-else class="pm-status muted">{{ p.enabled ? '已启用' : '已禁用' }}</span>

          <!-- 右侧固定按钮：图标 + 悬停文字 -->
          <div class="pm-actions">
            <!-- 打开（content 插件 / hostApp） -->
            <button
              v-if="p.enabled && (p.kind === 'hostApp' || p.slot === 'content')"
              type="button"
              class="icon-btn"
              title="打开"
              @click="store.navigatePlugin(p.id)"
            >
              <AppIcon name="open" :size="15" />
            </button>
            <!-- hostApp：启动 / 停止 -->
            <template v-if="p.kind === 'hostApp'">
              <button
                v-if="store.agentStateOf(p.id).status === 'ready'"
                type="button"
                class="icon-btn"
                title="停止"
                :disabled="!p.enabled"
                @click="store.stopAgent(p.id)"
              >
                <AppIcon name="stop" :size="15" />
              </button>
              <button
                v-else-if="store.agentStateOf(p.id).status !== 'starting'"
                type="button"
                class="icon-btn"
                title="启动"
                :disabled="!p.enabled"
                @click="store.startAgent(p.id)"
              >
                <AppIcon name="play" :size="15" />
              </button>
              <!-- 升级 -->
              <button
                v-if="
                  store.updateInfos[p.id]?.hasUpdate &&
                  store.updateInfos[p.id].latest &&
                  !isUpgrading(p.id)
                "
                type="button"
                class="icon-btn accent"
                title="升级"
                @click="store.upgradeAgent(p.id, store.updateInfos[p.id].latest!)"
              >
                <AppIcon name="upgrade" :size="15" />
              </button>
              <!-- 检查更新 -->
              <button
                type="button"
                class="icon-btn"
                :disabled="store.checkingIds[p.id] || isUpgrading(p.id)"
                :title="store.checkingIds[p.id] ? '检查中…' : '检查更新'"
                @click="store.checkAgentUpdate(p.id)"
              >
                <AppIcon name="refresh" :size="15" />
              </button>
            </template>
            <!-- 卸载（外部插件 / hostApp） -->
            <button
              v-if="p.source === 'external' || p.kind === 'hostApp'"
              type="button"
              class="icon-btn danger"
              title="卸载"
              @click="p.kind === 'hostApp' ? onUninstallHostApp(p) : onUninstall(p)"
            >
              <AppIcon name="trash" :size="15" />
            </button>
            <!-- 启用 / 禁用 -->
            <button
              type="button"
              class="icon-btn"
              :class="{ active: p.enabled }"
              :title="p.enabled ? '禁用' : '启用'"
              @click="store.togglePlugin(p.id)"
            >
              <AppIcon name="power" :size="15" />
            </button>
          </div>

          <!-- 升级进度/状态 -->
          <template v-if="p.kind === 'hostApp' && store.upgradeStates[p.id]">
            <span v-if="store.upgradeStates[p.id].phase === 'installing'" class="pm-status">
              升级中…
            </span>
            <span
              v-else-if="store.upgradeStates[p.id].phase === 'done'"
              class="pm-status update-text"
            >
              升级完成
            </span>
            <span
              v-else-if="store.upgradeStates[p.id].phase === 'error'"
              class="pm-status danger-text"
            >
              {{ store.upgradeStates[p.id].message }}
            </span>
          </template>
        </div>
      </div>

      <div v-if="!filtered.length" class="empty">
        <p v-if="query">没有匹配「{{ query }}」的插件</p>
        <p v-else-if="store.settings.safeMode">安全模式已开启，第三方插件已隐藏。</p>
        <p v-else>还没有本地插件。可从本地 zip 安装。</p>
      </div>
    </div>

    <MarketDialog v-if="marketOpen" @close="marketOpen = false" />
  </div>
</template>

<style scoped>
.plugins-view {
  max-width: 960px;
  height: 100%;
  min-height: 0;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.pm-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
}
.view-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-tight);
}
.view-sub {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}
.pm-actions {
  display: flex;
  gap: var(--space-2);
  flex: none;
}

/* 搜索栏（无外层线框，搜索框 + 计数 + 安全模式同行） */
.pm-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.pm-count {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  white-space: nowrap;
}
.safe-mode-toggle {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}
.safe-mode-text {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  white-space: nowrap;
}
/* Element Plus 搜索框：占满剩余宽度（令牌样式由 main.css §10 对齐） */
.search-box {
  width: 360px;
}

/* 插件列表 */
.pm-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow-y: auto;
}
.pm-row {
  display: flex;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  scroll-margin-top: var(--space-2);
  transition: background var(--duration-fast) var(--ease-out);
}
.pm-row:last-child {
  border-bottom: none;
}
.pm-row:hover {
  background: var(--surface-2);
}
.pm-row.focus {
  background: var(--surface-2);
  box-shadow: inset 2px 0 0 var(--accent);
}
.pm-row.off {
  opacity: 0.6;
}

/* 左侧三行信息 */
.pm-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.pm-line1 {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.pm-ic {
  flex: none;
}
.pm-icon {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
}
.pm-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
}
.pm-line2 {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.pm-line3 {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

/* 右侧：运行状态 + 固定图标按钮 */
.pm-right {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
}
.pm-status {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--text-muted);
}
.pm-status.st-ready {
  color: var(--success);
}
.pm-status.st-starting {
  color: var(--accent);
}
.pm-status.st-error {
  color: var(--danger);
}
.pm-status.muted {
  color: var(--text-muted);
}
.pm-status.danger-text {
  color: var(--danger);
}
.pm-actions {
  display: flex;
  gap: 2px;
}
.icon-btn {
  width: 28px;
  height: 28px;
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
.icon-btn.active {
  color: var(--accent);
}
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

.hl {
  background: transparent;
  color: var(--accent);
  font-weight: var(--font-weight-semibold);
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
.error-text {
  color: var(--danger);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
}
.update-text {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
.update-text.new {
  color: var(--accent);
  font-weight: var(--font-weight-semibold);
}

.empty {
  padding: var(--space-6);
  text-align: center;
  color: var(--text-muted);
}
.empty p {
  margin: 0;
}
</style>
