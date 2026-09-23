 ; Included by the assisted welcome hooks after multiUser.nsh declares its
; macro, but before PAGE_INSTALL_MODE or .onInit expands it. Preserve upstream
; registry, known-folder and fallback behavior. Bound the known-folder copy
; and preserve the documented /D= tail argument, including unquoted spaces.
!ifndef RELAY_SAFE_USER_PATH_INCLUDED
!define RELAY_SAFE_USER_PATH_INCLUDED
!macro RelayReadInstallDir
  ; NSIS removes /D= from $CMDLINE and GetParameters. StdUtils truncates an
  ; unquoted value at its first space, so read the original Win32 command line.
  Push $0
  StrCpy $R0 ""
  System::Call 'kernel32::GetCommandLineW() w.r0'
  ${GetOptions} $0 "/D=" $R0
  ClearErrors
  Pop $0
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${EndIf}
!macroend
!ifndef INSTALL_MODE_PER_ALL_USERS
!macroundef setInstallModePerUser
!macro setInstallModePerUser
  StrCpy $installMode CurrentUser
  SetShellVarContext current
  ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $perUserInstallationFolder != ""
    StrCpy $INSTDIR $perUserInstallationFolder
  ${Else}
    StrCpy $0 "$LocalAppData\Programs"
    System::Store S
    System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
    ${If} $1 == 0
      System::Call 'kernel32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})'
      System::Call 'OLE32::CoTaskMemFree(p r2)'
    ${EndIf}
    System::Store L
    StrCpy $INSTDIR "$0\${APP_FILENAME}"
  ${EndIf}
  !insertmacro RelayReadInstallDir
!macroend
!endif
!ifdef INSTALL_MODE_PER_ALL_USERS_REQUIRED
!macroundef setInstallModePerAllUsers
  !macro setInstallModePerAllUsers
    StrCpy $installMode all
    SetShellVarContext all

    !ifdef BUILD_UNINSTALLER
      ${IfNot} ${UAC_IsAdmin}
        ShowWindow $HWNDPARENT ${SW_HIDE}
        !insertmacro UAC_RunElevated
        Quit
      ${endif}
    !endif

    # сheck registry for previous installation path
    ReadRegStr $perMachineInstallationFolder HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $perMachineInstallationFolder != ""
      StrCpy $INSTDIR $perMachineInstallationFolder
    ${else}
      StrCpy $0 "$PROGRAMFILES"
      !ifdef APP_64
        ${if} ${RunningX64}
          StrCpy $0 "$PROGRAMFILES64"
        ${endif}
      !endif

      !ifdef MENU_FILENAME
        StrCpy $0 "$0\${MENU_FILENAME}"
      !endif

      StrCpy $INSTDIR "$0\${APP_FILENAME}"
    ${endif}

    # allow /D switch to override installation path https://github.com/electron-userland/electron-builder/issues/1551
    !insertmacro RelayReadInstallDir

  !macroend
!endif
!endif
