# Demo Host

外部宿主应用（hostApp）示例插件：**插件目录自包含**——`manifest.json`、`package.json`、`lib/` 都在插件目录内，zip 整个插件目录即可导入安装，离线运行。

## 功能

- 以独立进程运行一个最小 HTTP 服务
- 就绪后壳层用 `WebContentsView` 嵌入其 Web UI
- 演示多宿主可插拔：hostApp 插件本地自包含模式（`hostDir`）

## 使用

1. 在插件管理页找到 **Demo Host**
2. 点「打开」或「启动」运行
3. 卸载会停止进程并删除其数据目录

> 安全提示：hostApp 以**独立进程 + 完全系统权限**运行，仅安装你信任的包。
