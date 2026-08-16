import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// 版本号唯一来源：package.json。构建时注入 __APP_VERSION__，避免渲染进程硬编码漂移。
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
  },
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            // 插件 UI 以自定义元素 <app-plugin-*> 承载，让 Vue 视为原生元素
            isCustomElement: (tag) => tag.startsWith('app-plugin-'),
          },
        },
      }),
      // Element Plus 按需引入（docs/设计规范.md §10）：组件 + API 自动导入，样式按组件打包
      AutoImport({
        resolvers: [ElementPlusResolver()],
        dts: resolve('src/renderer/src/auto-imports.d.ts'),
      }),
      Components({
        resolvers: [ElementPlusResolver()],
        dts: resolve('src/renderer/src/components.d.ts'),
      }),
    ],
  },
})
