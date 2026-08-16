; ============================================================
; AnythingPlugin 卸载器：询问是否同时清除应用数据
; 经 electron-builder `nsis.include` 注入（electron-builder.yml）。
; 行为：
;   - 标准卸载欢迎页后插入一个询问页（默认不勾选 → 保留数据）
;   - 勾选「同时清除应用数据」→ 删除 %APPDATA%\anythingplugin
;   - 静默卸载（/S）跳过页面 → 保留数据；--delete-app-data 参数不受影响
; 注意：本文件在 MUI2 include 之前被解析，所有引用 MUI 宏的代码
; 必须放进 customUnWelcomePage 宏（在 assistedInstaller.nsh 中展开，
; 此时 MUI2 已就绪），不能写在顶层函数里。
; ============================================================

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME

  ; 仅在卸载器编译时声明（安装器编译不展开本宏，避免 6001 未引用 warning）
  Var /GLOBAL un.DataCheckbox
  Var /GLOBAL un.DeleteAppData

  Function un.DataPageCreate
    !insertmacro MUI_HEADER_TEXT "清除应用数据" "是否同时清除应用数据？"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 20u "应用数据（设置、插件与插件数据）默认保留。"
    Pop $0

    ${NSD_CreateCheckbox} 0 28u 100% 12u "同时清除应用数据"
    Pop $un.DataCheckbox
    ${NSD_SetState} $un.DataCheckbox 0

    nsDialogs::Show
  FunctionEnd

  Function un.DataPageLeave
    ${NSD_GetState} $un.DataCheckbox $un.DeleteAppData
  FunctionEnd

  PageEx un.custom
    PageCallbacks un.DataPageCreate un.DataPageLeave
  PageExEnd
!macroend

!macro customUnInstall
  ${if} $un.DeleteAppData == "1"
    # 与 electron-builder 内置 --delete-app-data 相同的删除范围（electron 总是 per-user appdata）
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
