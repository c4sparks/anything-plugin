<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { store } from '../store'
import type { AppInfo } from '@shared/ipc'

const appInfo = ref<AppInfo | null>(null)

// 构建时由 electron.vite.config.ts 注入，与 package.json 同步
const APP_VERSION = __APP_VERSION__

const ABOUT_TEXT =
  'AnythingPlugin 是一个插件化桌面应用：扩展功能以插件形式安装使用，即装即用、按需卸载。' +
  '内置 DeepSeek Harness（AI 助手），支持从本地插件包安装新功能。'

onMounted(() => {
  void window.api.app
    .info()
    .then((info) => {
      appInfo.value = info
    })
    .catch(() => {
      /* 获取失败保持空态 */
    })
})

async function copyDataPath(): Promise<void> {
  const path = appInfo.value?.userDataPath
  if (!path) return
  try {
    await navigator.clipboard.writeText(path)
    ElMessage.success('数据目录已复制')
  } catch {
    /* 剪贴板不可用时忽略 */
  }
}
</script>

<template>
  <div class="settings-view">
    <h1 class="view-title">设置</h1>

    <section class="panel">
      <h2 class="section-title">外观</h2>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">界面主题</div>
          <div class="setting-desc">
            切换明暗主题，即时生效并持久化。插件通过主题契约变量自动跟随。
          </div>
        </div>
        <el-radio-group
          :model-value="store.settings.theme"
          aria-label="界面主题"
          @update:model-value="(v) => store.setTheme(v as 'light' | 'dark')"
        >
          <el-radio-button value="light">浅色</el-radio-button>
          <el-radio-button value="dark">深色</el-radio-button>
        </el-radio-group>
      </div>
    </section>

    <section class="panel">
      <h2 class="section-title">关于</h2>
      <div class="about-list">
        <div class="about-item">
          <span class="about-label">简介</span>
          <el-input
            class="intro-input"
            type="textarea"
            :rows="3"
            :model-value="ABOUT_TEXT"
            readonly
            resize="none"
          />
        </div>
        <div class="about-item">
          <span class="about-label">版本</span>
          <span class="about-value">v{{ appInfo?.version ?? APP_VERSION }}</span>
        </div>
        <div class="about-item">
          <span class="about-label">数据目录</span>
          <div class="data-line">
            <code class="path" :title="appInfo?.userDataPath">{{
              appInfo?.userDataPath ?? '…'
            }}</code>
            <el-button size="small" :disabled="!appInfo?.userDataPath" @click="copyDataPath">
              复制
            </el-button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-view {
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.view-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-tight);
}

.panel {
  padding: var(--space-5);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-1);
}
.section-title {
  margin: 0 0 var(--space-4);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  padding: var(--space-2) 0;
}
.setting-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
}
.setting-desc {
  margin-top: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  line-height: var(--line-height-base);
}

.about-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.about-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}
.about-item:last-child {
  align-items: center;
}
.about-label {
  flex: none;
  width: 72px;
  padding-top: 2px;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}
.intro-input {
  flex: 1;
  min-width: 0;
}
.intro-input :deep(.el-textarea__inner) {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-base);
  resize: none;
  box-shadow: none;
}
.intro-input :deep(.el-textarea__inner:focus) {
  border-color: var(--border);
  box-shadow: none;
}
.about-value {
  font-size: var(--font-size-base);
  color: var(--text);
}
.data-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  white-space: nowrap;
}
.path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: text;
}
</style>
