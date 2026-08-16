import pluginVue from 'eslint-plugin-vue'
import { withVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import prettierConfig from '@vue/eslint-config-prettier'

// withVueTs 返回 Promise，ESLint 支持异步 config 导出
export default withVueTs(
  [
    { ignores: ['out', 'dist', 'release', 'resources', 'node_modules'] },
    pluginVue.configs['flat/recommended'],
  ],
  vueTsConfigs.recommended,
  prettierConfig,
)
