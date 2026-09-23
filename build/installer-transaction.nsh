; Embedded, fixed-identity helper. No runtime GUID, product, script, or registry
; override is exposed by the production installer command line.
Var RelayTransactionAction
Var RelayTransactionScope
Var RelayTransactionState
Var RelayTransactionCode
!ifndef BUILD_UNINSTALLER
Var RelayMigrationHandled
!endif

!macro RelayTransactionFunctions PREFIX
  Function ${PREFIX}RelayRunTransaction
    InitPluginsDir
    StrCpy $RelayTransactionState "$PLUGINSDIR\relay-transaction-$RelayTransactionScope.json"
    ${If} $RelayTransactionAction == "Commit"
    ${OrIf} $RelayTransactionAction == "Rollback"
      IfFileExists "$RelayTransactionState" +3
        StrCpy $RelayTransactionCode 0
        Return
    ${EndIf}
    SetOutPath "$PLUGINSDIR"
    IfFileExists "$PLUGINSDIR\relay-installer-transaction.ps1" relay_helper_ready
      File /oname=$PLUGINSDIR\relay-installer-transaction.ps1 "${BUILD_RESOURCES_DIR}\installer-transaction.ps1"
    relay_helper_ready:
    !ifndef BUILD_UNINSTALLER
      IfFileExists "$PLUGINSDIR\relay-installer-manifest.json" relay_manifest_ready
        File /oname=$PLUGINSDIR\relay-installer-manifest.json "${BUILD_RESOURCES_DIR}\installer-payload-manifest.json"
      relay_manifest_ready:
    !endif
    StrCpy $RelayTransactionState "$PLUGINSDIR\relay-transaction-$RelayTransactionScope.json"
    ClearErrors
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\relay-installer-transaction.ps1" -Action "$RelayTransactionAction" -StatePath "$RelayTransactionState" -InstallDir "$INSTDIR" -Scope "$RelayTransactionScope" -ProductName "${PRODUCT_FILENAME}" -InstallKey "${INSTALL_REGISTRY_KEY}" -UninstallKey "${UNINSTALL_REGISTRY_KEY}" -Version "${VERSION}" -ShortcutPaths "$oldStartMenuLink|$newStartMenuLink|$oldDesktopLink|$newDesktopLink" -ManifestPath "$PLUGINSDIR\relay-installer-manifest.json"' $RelayTransactionCode
    ${If} ${Errors}
      StrCpy $RelayTransactionCode "2"
    ${EndIf}
    ${If} $RelayTransactionCode != 0
    ${AndIf} $RelayTransactionCode != 10
      DetailPrint "安装事务失败（$RelayTransactionCode）。原程序的恢复副本保留在安装目录旁。"
      IfFileExists "$RelayTransactionState.error.txt" 0 relay_helper_done
      FileOpen $0 "$RelayTransactionState.error.txt" r
      FileRead $0 $1
      FileClose $0
      DetailPrint "$1"
    ${EndIf}
    relay_helper_done:
  FunctionEnd

  Function ${PREFIX}RelayRollbackTransactions
    StrCpy $RelayTransactionAction "Rollback"
    StrCpy $RelayTransactionScope "CurrentUser"
    Call ${PREFIX}RelayRunTransaction
    StrCpy $RelayTransactionScope "AllUsers"
    Call ${PREFIX}RelayRunTransaction
  FunctionEnd
!macroend

!macro RelayCommitTransactions PREFIX
  StrCpy $RelayTransactionAction "Commit"
  StrCpy $RelayTransactionScope "CurrentUser"
  Call ${PREFIX}RelayRunTransaction
  ${If} $RelayTransactionCode != 0
    Call ${PREFIX}RelayRollbackTransactions
    SetErrorLevel 2
    Abort "安装结果校验失败，已保留恢复副本。"
  ${EndIf}
  StrCpy $RelayTransactionScope "AllUsers"
  Call ${PREFIX}RelayRunTransaction
  ${If} $RelayTransactionCode != 0
    Call ${PREFIX}RelayRollbackTransactions
    SetErrorLevel 2
    Abort "安装结果校验失败，已保留恢复副本。"
  ${EndIf}
!macroend

!macro RelayBeginLegacy ROOT_KEY
  StrCpy $RelayMigrationHandled "0"
  ${If} "${ROOT_KEY}" == "HKEY_CURRENT_USER"
  ${OrIf} $installMode == "CurrentUser"
    StrCpy $RelayTransactionScope "CurrentUser"
  ${Else}
    StrCpy $RelayTransactionScope "AllUsers"
  ${EndIf}
  StrCpy $RelayTransactionAction "Begin"
  Call RelayRunTransaction
  ${If} $RelayTransactionCode == 0
    StrCpy $RelayMigrationHandled "1"
    StrCpy $R0 0
    ClearErrors
  ${ElseIf} $RelayTransactionCode != 10
    Call RelayRollbackTransactions
    Call RelayUIFailure
    SetErrorLevel 2
    Abort "旧版本文件无法安全迁移，请关闭占用文件的程序后重试。"
  ${EndIf}
!macroend

!macro RelayVerifyPayload
  StrCpy $RelayTransactionAction "Verify"
  ${If} $installMode == "CurrentUser"
    StrCpy $RelayTransactionScope "CurrentUser"
  ${Else}
    StrCpy $RelayTransactionScope "AllUsers"
  ${EndIf}
  Call RelayRunTransaction
  ${If} $RelayTransactionCode != 0
    Call RelayRollbackTransactions
    Call RelayUIFailure
    SetErrorLevel 2
    Abort "应用文件完整性校验失败，已尝试恢复旧版本。"
  ${EndIf}
!macroend
