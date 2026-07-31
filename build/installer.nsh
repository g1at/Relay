; Relay 安装程序定制
;   界面重绘 → build/installer-ui.nsh
;   流程钩子 → 下方各 custom* 宏(由 electron-builder 的 NSIS 模板展开)

!ifndef BUILD_UNINSTALLER
  !define RELAY_UI_ICON "${BUILD_RESOURCES_DIR}\icon.ico"
  !include "${BUILD_RESOURCES_DIR}\installer-ui.nsh"
!endif

; 跳过「为谁安装」选择页,固定当前用户安装
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; 该钩子紧接在 MUI_PAGE_INSTFILES 声明之前展开
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW RelayStyleInstallPage
!macroend

; 装完直接拉起 Relay 并退出安装器 —— 不出「安装完成」页,
; 后续引导交给应用内的首次设置向导(installer/wizard.html)。
; 交互安装复刻 electron-builder 自己 oneClick 路径的做法:
;   HideWindow  —— 否则应用窗口会开在安装器后面
;   --updated   —— 升级场景应用要据此判断,和 StartApp 宏保持一致
;   quitSuccess —— SetErrorLevel 0 + Quit,避免退出码 2
; 注意不能直接 !insertmacro StartApp:它内含 Var /GLOBAL startAppArgs,
; 而 installSection.nsh 后面还会再插一次,变量会重复声明导致编译失败。
; StdUtils.ExecShellAsUser 是靠工作线程异步拉起的,Quit 太快会把它掐掉,
; 所以中间留一小段时间让请求真正发出去。
;
; 静默安装(electron-updater 自动更新走的就是 /S)必须原样放行 ——
; 此时不能提前 Quit,否则会跳过 installSection.nsh 里
; 「isForceRun && Silent → doStartApp」那段,更新完应用就再也起不来了。
!macro customInstall
  ${IfNot} ${Silent}
    HideWindow
    ${if} ${isUpdated}
      StrCpy $0 "--updated"
    ${else}
      StrCpy $0 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $1 "$launchLink" "open" "$0"
    Sleep 800
    !insertmacro quitSuccess
  ${EndIf}
!macroend

!macro customFinishPage
!macroend

!macro customHeader
  BrandingText "Relay"
!macroend
