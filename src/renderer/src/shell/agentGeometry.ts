import { onBeforeUnmount, onMounted, watch } from 'vue'
import { store } from './store'

/**
 * 把内容区（`.content`）几何持续上报给主进程，供 agent WebContentsView 定位。
 * - ResizeObserver 覆盖尺寸变化（拖窗/最大化）；
 * - 侧栏折叠 / 视图切换改变 `.content` 的 x 位置但不改尺寸，ResizeObserver 不触发 → 用 watch 补报。
 * 只在上报值变化时才发 IPC，避免无谓刷屏。
 */
export function useAgentGeometry(): void {
  let raf = 0
  let last = ''
  let ro: ResizeObserver | null = null

  const report = (): void => {
    const el = document.querySelector<HTMLElement>('.content')
    if (!el) return
    const r = el.getBoundingClientRect()
    const rect = {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
    if (key !== last) {
      last = key
      // 所有 hostApp 插件视图共用一个内容区几何（只有激活的那个可见）
      for (const p of store.hostAppItems()) {
        void window.api.agent.setBounds(p.id, rect)
      }
    }
  }

  const schedule = (): void => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(report)
  }

  onMounted(() => {
    const el = document.querySelector<HTMLElement>('.content')
    if (el) {
      ro = new ResizeObserver(schedule)
      ro.observe(el)
    }
    window.addEventListener('resize', schedule)
    schedule()
  })

  onBeforeUnmount(() => {
    ro?.disconnect()
    window.removeEventListener('resize', schedule)
  })

  watch(() => store.settings.sidebarCollapsed, schedule)
  watch(() => store.currentView, schedule)
}
