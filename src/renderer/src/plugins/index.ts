import { registerHostAppPlugin } from './registry'
import { DSH_HOST_APP } from '@shared/hostApp'

// 内置插件：编译期静态注册（Vue SFC → 自定义元素）。
// 新增内置插件：在 widgets/ 下建 SFC，然后在此 registerVuePlugin(...) 即可。
// hello 示例已于 0.0.13 移除（示例使命完成，由外部 demo 插件承担）。

// 内置宿主应用插件（dsh Agent）：kind 固定 hostApp，无 tag，图标/版本走专用分支。
registerHostAppPlugin({
  id: DSH_HOST_APP.id,
  name: DSH_HOST_APP.name,
  shortName: DSH_HOST_APP.shortName,
  iconName: DSH_HOST_APP.icon,
  hostApp: DSH_HOST_APP,
  slot: 'content',
  order: 1,
  description: DSH_HOST_APP.description,
  source: 'builtin',
  tier: 'trusted',
  enabled: true,
})

export { loadExternalPlugins } from './loader'
export type { AppPlugin, PluginItem, PluginSource } from './types'
export {
  registerPlugin,
  registerHostAppPlugin,
  registerVuePlugin,
  unregisterPlugin,
  getPlugins,
} from './registry'
