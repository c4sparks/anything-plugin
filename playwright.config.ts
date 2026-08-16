import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1, // Electron 单实例锁：串行
  retries: 0,
})
