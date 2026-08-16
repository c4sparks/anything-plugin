import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 壳层 + 宿主应用插件 e2e（需先 `pnpm build` 产出 out/，且无其它 anythingplugin 实例运行）。
 * 用独立临时 userData（`--user-data-dir`）保证默认设置（插件全启用），不被本地 settings 污染。
 * `--in-process-gpu`：无 GPU 环境（CI/沙箱）下避免 GPU 进程崩溃（0xC0000135 DLL 缺失）。
 */
test('壳层加载 + 插件列表（统一）+ hostApp 启动', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'ap-e2e-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--in-process-gpu'],
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 首页加载（hero 标题）；插件初始化需要时间，侧栏断言用较长超时
  await expect(win.locator('.hero-title')).toBeVisible({ timeout: 15000 })

  // 侧栏「已安装插件」区有 AI 助手（hostApp）
  const dshCard = win.locator('.sidebar-scroll .slot-card', { hasText: 'AI 助手' })
  await expect(dshCard).toBeVisible({ timeout: 15000 })

  // 点击 AI 助手 → 导航到 hostApp 视图并启动侧车（视图激活）
  await dshCard.click()
  await expect(dshCard).toHaveClass(/active/)

  // 插件页：统一列表（无 Tab），包含内置 dsh 与外部 hostApp、webComponent
  await win.locator('.activity-item', { hasText: '插件' }).click()

  // 无分类 Tab（统一列表）
  await expect(win.locator('.pm-tab')).toHaveCount(0)

  // 内置 hostApp：DeepSeek Harness + 宿主应用徽标 + 运行状态
  const agentRow = win.locator('.pm-row', { hasText: 'DeepSeek Harness' })
  await expect(agentRow).toBeVisible()
  await expect(agentRow.locator('.badge.host-app')).toHaveText('hostApp')
  await expect(agentRow.locator('.badge.builtin')).toHaveText('内置')
  // 状态元素存在即可（不依赖侧车 ready 的时序）
  await expect(agentRow.locator('.pm-status')).toBeVisible()

  // 外部 hostApp：Demo Host + 独立程序警示
  const demoRow = win.locator('.pm-row', { hasText: 'Demo Host' })
  await expect(demoRow).toBeVisible()
  await expect(demoRow.locator('.badge.host-warn')).toHaveText('独立程序')

  // 图标按钮带 title 悬停文字
  const openBtn = agentRow.locator('.icon-btn[title="打开"]')
  await expect(openBtn).toBeVisible()

  // 双击插件行 → 详情页（左=描述+README，右=元信息面板）
  await demoRow.dblclick()
  await expect(win.locator('.pd-name')).toHaveText('Demo Host')
  await expect(win.locator('.pd-side-desc')).toContainText('外部宿主应用示例')
  await expect(win.locator('.pd-side')).toContainText('许可证')
  await expect(win.locator('.pd-side')).toContainText('MIT')
  // README Markdown 渲染（h1）
  await expect(win.locator('.pd-readme h1')).toHaveText('Demo Host')
  // 返回
  await win.locator('.pd-nav .btn').click()
  await expect(win.locator('.pm-list')).toBeVisible()

  await app.close()
})
