; Relay installation lifecycle. Keep electron-builder's silent updater path and
; file/registry ownership; UI is shared by installer and uninstaller builds.
!define RELAY_UI_ICON "${BUILD_RESOURCES_DIR}\icon.ico"
!include "${BUILD_RESOURCES_DIR}\installer-ui.nsh"
!include "FileFunc.nsh"
!include "MUI2.nsh"
; Declaring customCheckAppRunning prevents electron-builder from providing
; these two defaults. Keep them for the unchanged non-CLI fallback below.
!include "getProcessInfo.nsh"
Var pid
Var RelayNoCloseMode
!include "${BUILD_RESOURCES_DIR}\installer-transaction.nsh"

; Future CLI installers opt in explicitly. A process-local environment marker
; carries the policy to a newly built uninstaller invoked by the stock upgrade
; transaction. Previously published installers/uninstallers do not understand
; this contract; a bootstrap must not infer support merely from the flag.
!macro customInit
  Call RelayNoClosePreflight
!macroend

!macro customCheckAppRunning
  Call ${RELAY_UI_PREFIX}RelayNoClosePreflight
  ${If} $RelayNoCloseMode != "1"
    !insertmacro _CHECK_APP_RUNNING
  ${EndIf}
  !include "${BUILD_RESOURCES_DIR}\installer-legacy-upgrade.nsh"
!macroend

!ifdef BUILD_UNINSTALLER
  ; electron-builder 25 inserts its install-mode page between the uninstall
  ; welcome and progress pages. That page consumes MUI custom callbacks, so
  ; attach ours inside the actual progress-page declaration instead.
  !macroundef MUI_UNPAGE_INSTFILES
  !macro MUI_UNPAGE_INSTFILES
    !verbose push
    !verbose ${MUI_VERBOSE}
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.RelayStyleInstallPage
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.RelayInstallPageDone
    !insertmacro MUI_UNPAGE_INIT
    !insertmacro MUI_PAGEDECLARATION_INSTFILES
    !verbose pop
  !macroend
!endif

!macro customHeader
  !insertmacro RelayTransactionFunctions "${RELAY_UI_PREFIX}"
  BrandingText "Relay"
  ShowInstDetails hide
  ShowUninstDetails hide
  Function ${RELAY_UI_PREFIX}RelayNoClosePreflight
    Push $0
    Push $R8
    Push $R9
    StrCpy $RelayNoCloseMode "0"
    ${StdUtils.TestParameter} $R8 "relay-no-close"
    ReadEnvStr $R9 "RELAY_INSTALL_NO_CLOSE"
    ClearErrors
    ${If} $R8 == "true"
    ${OrIf} $R9 == "1"
      StrCpy $RelayNoCloseMode "1"
      ; No registry or permanent user environment is changed.
      System::Call 'kernel32::SetEnvironmentVariableW(w "RELAY_INSTALL_NO_CLOSE", w "1") i .r0'
      ${If} $0 == 0
        DetailPrint "无法为本次安装设置安全策略，安装已停止。"
        SetErrorLevel 5
        Quit
      ${EndIf}
      ; Check all users conservatively. Never enter the stock taskkill path.
      ; nsProcess returns 603 only when no matching process was found.
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
      ${If} $0 == 0
        DetailPrint "Relay 仍在运行。请先退出 Relay（包括托盘），再重新安装。"
        SetErrorLevel 32
        Quit
      ${ElseIf} $0 != 603
        DetailPrint "无法确认 Relay 是否已经退出，安装已停止。"
        SetErrorLevel 5
        Quit
      ${EndIf}
    ${EndIf}
    Pop $R9
    Pop $R8
    Pop $0
  FunctionEnd
  !ifndef BUILD_UNINSTALLER
  !ifndef HIDE_RUN_AFTER_FINISH
    ; customHeader expands after electron-builder registers StdUtils plugins.
    ; A top-level function in this include would resolve those plugins early.
    Function RelayStartAfterInstall
      Push $0
      Push $1
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
      Pop $1
      Pop $0
    FunctionEnd
  !endif
  !endif
!macroend

; New installations remain per-user. Preserve the scope of an older machine
; installation, and let the stock uninstaller resolve its registered owner.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${If} $hasPerMachineInstallation == "1"
    ${AndIf} $hasPerUserInstallation != "1"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  Function .onGUIEnd
    Call RelayRollbackTransactions
    Call RelayUIDestroy
  FunctionEnd

  Function RelayInstallPageDone
    IfAbort failed
      Call RelayUISuccess
      Return
    failed:
      Call RelayUIFailure
  FunctionEnd

  Function .onInstFailed
    Call RelayRollbackTransactions
    Call RelayUIFailure
  FunctionEnd

!else
  Var RelayUninstallFinishText

  Function un.onGUIEnd
    Call un.RelayRollbackTransactions
    Call un.RelayUIDestroy
  FunctionEnd

  Function un.RelayInstallPageDone
    IfAbort failed
      Call un.RelayUISuccess
      Return
    failed:
      Call un.RelayUIFailure
  FunctionEnd

  Function un.onUninstFailed
    Call un.RelayRollbackTransactions
    Call un.RelayUIFailure
  FunctionEnd
!endif

!macro customWelcomePage
  !include "${BUILD_RESOURCES_DIR}\installer-safe-user-path.nsh"
  !define MUI_WELCOMEPAGE_TITLE "安装 Relay"
  !define MUI_WELCOMEPAGE_TEXT "开始安装您的本地 AI 助手。"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW RelayStyleWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW RelayStyleInstallPage
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE RelayInstallPageDone
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT "Relay 已安装，可以开始使用。"
  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_TEXT "打开 Relay"
    !define MUI_FINISHPAGE_RUN_FUNCTION RelayStartAfterInstall
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW RelayStyleFinishPage
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnInit
  Call un.RelayNoClosePreflight
  StrCpy $RelayUIDataPolicy "keep"
  StrCpy $RelayUninstallFinishText "安装目录外的会话、设置与项目文件已保留。"
  Push $0
  Push $1
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--delete-app-data" $1
  ${IfNot} ${Errors}
    StrCpy $RelayUIDataPolicy "delete"
    StrCpy $RelayUninstallFinishText "已按本次要求清理本地应用数据。"
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
!macroend

!macro customUnWelcomePage
  !include "${BUILD_RESOURCES_DIR}\installer-safe-user-path.nsh"
  !define MUI_WELCOMEPAGE_TITLE "卸载 Relay"
  !define MUI_WELCOMEPAGE_TEXT "移除应用，保留安装目录外的个人文件。"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.RelayStyleWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUninstallPage
  ; This hook precedes the stock MUI_UNPAGE_FINISH; don't insert a duplicate.
  !define MUI_FINISHPAGE_TITLE "卸载完成"
  !define MUI_FINISHPAGE_TEXT "$RelayUninstallFinishText"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.RelayStyleFinishPage
!macroend

; This hook is after extraction, registration and shortcuts, but before the
; normal silent --force-run handling. Validate the installed payload and then
; return, allowing the real section completion to drive the finish state.
!macro customInstall
  Push "正在确认安装结果…"
  Call RelayUISetStage
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 relay_payload_missing
  IfFileExists "$INSTDIR\resources\app.asar" 0 relay_payload_missing
    Goto relay_payload_ready
  relay_payload_missing:
    DetailPrint "Relay 的应用文件未完整写入，请重新运行安装程序。"
    Call RelayRollbackTransactions
    Call RelayUIFailure
    SetErrorLevel 2
    Abort "应用文件不完整，安装未完成。"
  relay_payload_ready:
  !insertmacro RelayVerifyPayload
  !insertmacro RelayCommitTransactions ""
!macroend

!macro customRemoveFiles
  Push "正在移除应用文件…"
  Call un.RelayUISetStage
  ; A same-volume transaction replaces upstream atomicRMDir, whose destination
  ; is TEMP and therefore fails when the installation is on a different drive.
  ; The helper checks deny-delete handles and ACLs before moving anything.
  ClearErrors
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ${If} ${Errors}
    Call un.RelayUIFailure
    SetErrorLevel 2
    Abort "无法切换到临时目录，尚未移除应用文件。"
  ${EndIf}
  ${If} $installMode == "CurrentUser"
    StrCpy $RelayTransactionScope "CurrentUser"
  ${Else}
    StrCpy $RelayTransactionScope "AllUsers"
  ${EndIf}
  StrCpy $RelayTransactionAction "Remove"
  Call un.RelayRunTransaction
  ${If} $RelayTransactionCode != 0
    Call un.RelayRollbackTransactions
    Call un.RelayUIFailure
    SetErrorLevel 2
    Abort "应用文件正在使用或无法访问，卸载未完成。"
  ${EndIf}
!macroend

!macro customUnInstall
  Push "正在完成卸载…"
  Call un.RelayUISetStage
  !insertmacro RelayCommitTransactions "un."
!macroend
