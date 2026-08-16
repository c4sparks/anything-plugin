/**
 * 插件市场共享类型（P3 实现注册表；当前市场未开放，available=false）。
 * 来源锁定 + sha256 校验见 功能设计.md §12.4 / 详细设计.md §11.2。
 */

/** 市场插件条目（注册表字段） */
export interface MarketPlugin {
  id: string
  name: string
  version: string
  description?: string
  publisher?: string
  /** 图标 URL / data URL */
  icon?: string
  /** 下载地址（zip） */
  downloadUrl: string
  /** zip 的 sha256（安装时强校验，防篡改） */
  sha256?: string
}

/** 市场搜索结果 */
export interface MarketSearchResult {
  /** 市场是否可用（未配置注册表返回 false，前端提示「市场未开放」） */
  available: boolean
  items: MarketPlugin[]
  /** 注册表拉取失败时的错误信息（前端优先展示） */
  error?: string
}
