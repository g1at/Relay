; Expanded by customCheckAppRunning after installUtil.nsh defines its macro,
; before installSection.nsh invokes it. The upstream function remains intact.
!ifndef BUILD_UNINSTALLER
!ifndef RELAY_LEGACY_UPGRADE_WRAPPED
!define RELAY_LEGACY_UPGRADE_WRAPPED
!ifmacrondef uninstallOldVersion
  !error "Unsupported electron-builder NSIS hook order: uninstallOldVersion is not defined"
!endif
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  !insertmacro RelayBeginLegacy "${ROOT_KEY}"
  ${If} $RelayMigrationHandled != "1"
    Push "${ROOT_KEY}"
    Call uninstallOldVersion
  ${EndIf}
!macroend
; The upstream result function uses Quit, which does not run .onGUIEnd in
; silent mode. Every failure after Begin must explicitly roll back first.
!ifmacrondef handleUninstallResult
  !error "Unsupported electron-builder NSIS uninstall-result hook order"
!endif
!macroundef handleUninstallResult
!macro handleUninstallResult ROOT_KEY
  ${If} ${Errors}
    Call RelayRollbackTransactions
    Call RelayUIFailure
    SetErrorLevel 2
    Abort "旧版卸载程序无法执行，已尝试恢复原安装。"
  ${ElseIf} $R0 != 0
    Call RelayRollbackTransactions
    Call RelayUIFailure
    SetErrorLevel 2
    Abort "旧版卸载程序返回错误，已尝试恢复原安装。"
  ${EndIf}
  ; Retain the upstream success hook and a real reference to its function;
  ; its Quit branch is unreachable after the checked zero result above.
  ClearErrors
  Push "${ROOT_KEY}"
  Call handleUninstallResult
!macroend
!ifdef ZIP_COMPRESSION
  !error "Relay transactional extraction currently requires the audited 7z packaging path"
!endif
; The stock last-resort extraction ignores write errors. A failed copy must
; roll back immediately, including silent installs; never publish half a tree.
!ifmacrondef extractUsing7za
  !error "Unsupported electron-builder NSIS extraction hook order"
!endif
!macroundef extractUsing7za
!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  SetOutPath "$PLUGINSDIR\7z-out"
  ClearErrors
  Nsis7z::Extract "${FILE}"
  Pop $R0
  SetOutPath $R0
  ClearErrors
  CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR
  ${If} ${Errors}
    Call RelayRollbackTransactions
    Call RelayUIFailure
    SetErrorLevel 2
    Abort "应用文件无法完整写入，已尝试恢复旧版本。"
  ${EndIf}
!macroend
!endif
!endif
