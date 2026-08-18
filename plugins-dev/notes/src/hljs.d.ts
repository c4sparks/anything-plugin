// hljs 子路径（lib/common）无独立 types 条件，提供最小类型声明
declare module 'highlight.js/lib/common' {
  interface HLJSApi {
    getLanguage(name: string): unknown
    highlight(code: string, opts: { language: string }): { value: string }
  }
  const hljs: HLJSApi
  export default hljs
}

// 构建脚本以 text loader 内联 .css（hljs 主题 / katex 布局）
declare module '*.css' {
  const css: string
  export default css
}
