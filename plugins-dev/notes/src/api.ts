// 宿主契约类型声明（docs/插件契约.md §5 plugin-data / §6 plugin-files）
// 主进程 preload 注入 window.api，插件按 id 路由调用；路径强校验在主进程完成。
import type { FileEntry } from './types'

declare global {
  interface Window {
    api: {
      /** 插件数据存储契约（§5）：userData/plugin-data/<id>/data.json */
      pluginData: {
        get(id: string, key: string): Promise<string | null>
        set(id: string, key: string, value: string): Promise<void>
        remove(id: string, key: string): Promise<void>
        clear(id: string): Promise<void>
      }
      /** 插件文件存储契约（§6）：userData/plugin-data/<id>/files/ */
      pluginFiles: {
        read(id: string, relPath: string): Promise<string>
        write(id: string, relPath: string, content: string): Promise<void>
        list(id: string, dirRel?: string): Promise<FileEntry[]>
        remove(id: string, relPath: string): Promise<void>
        mkdir(id: string, relPath: string): Promise<void>
        copy(id: string, from: string, to: string): Promise<void>
        move(id: string, from: string, to: string): Promise<void>
      }
    }
  }
}

export {}
