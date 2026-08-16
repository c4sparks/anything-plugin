import { createApp } from 'vue'
import App from './App.vue'
import { store } from './shell/store'
import './plugins' // 注册内置插件（编译期静态注册）
// Element Plus 深色变量（html.dark 生效；具体令牌覆盖见 assets/main.css §10）
import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/main.css'

async function bootstrap(): Promise<void> {
  // 先初始化壳层（应用主题 + 加载外部插件），再挂载，避免空壳闪烁
  await store.init()
  const app = createApp(App)
  // 说明：app-plugin-* 的 isCustomElement 已由 electron.vite.config.ts（构建期）配置；
  // 运行时配置在 runtime-only 构建下是 no-op 且会告警，故不再设置。
  app.mount('#app')
}

void bootstrap()
