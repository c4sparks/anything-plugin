// 入口：注册自定义元素（产物为单文件 ESM，宿主按 manifest tag 挂载到槽位）
import { NotesApp } from './notes-app'

customElements.define('app-plugin-notes', NotesApp)
