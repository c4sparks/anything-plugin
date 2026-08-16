<script setup lang="ts">
import type { HostAppIcon } from '@shared/hostApp'

/** 图标名与宿主应用定义的图标契约对齐（src/shared/hostApp.ts） */
export type IconName = HostAppIcon

withDefaults(defineProps<{ name: IconName; size?: number; flip?: boolean }>(), {
  size: 18,
  flip: false,
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="icon"
    :class="{ flip }"
    aria-hidden="true"
  >
    <template v-if="name === 'home'">
      <path d="M4 11.5 12 4.5l8 7" />
      <path d="M6 10.5V19h12v-8.5" />
    </template>
    <template v-else-if="name === 'plugin'">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </template>
    <template v-else-if="name === 'gear'">
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="7" cy="18" r="1.6" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'chevron'">
      <path d="M9 6l6 6-6 6" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </template>
    <template v-else-if="name === 'box'">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16" />
    </template>
    <template v-else-if="name === 'panel'">
      <!-- 折叠/展开侧栏统一图标（与外部插件约定一致，见 docs/设计规范.md 图标一致性） -->
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="M13 9l3 3-3 3" />
    </template>
    <template v-else-if="name === 'spark'">
      <path d="M12 3.5l2 5.5 5.5 2-5.5 2-2 5.5-2-5.5-5.5-2 5.5-2z" />
      <path d="M18.5 3.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </template>
    <template v-else-if="name === 'open'">
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 13v6H5V6h6" />
    </template>
    <template v-else-if="name === 'play'">
      <path d="M8 5.5v13l11-6.5z" />
    </template>
    <template v-else-if="name === 'stop'">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 3v5h-5" />
    </template>
    <template v-else-if="name === 'upgrade'">
      <path d="M12 4v12" />
      <path d="M6 10l6 6 6-6" />
      <path d="M5 20h14" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </template>
    <template v-else-if="name === 'power'">
      <path d="M12 3v9" />
      <path d="M6.5 6.5a8 8 0 1 0 11 0" />
    </template>
  </svg>
</template>

<style scoped>
.icon {
  flex: none;
  display: block;
}
.icon.flip {
  transform: scaleX(-1);
}
</style>
