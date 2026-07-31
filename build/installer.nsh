!include "WinMessages.nsh"
!include "LogicLib.nsh"

; Relay's neutral surface colors for the native MUI installer.
!define MUI_BGCOLOR F7F8FA
!define MUI_TEXTCOLOR 202124
!define MUI_INSTFILESPAGE_COLORS "F7F8FA 202124"

!ifndef BUILD_UNINSTALLER
Var RelayInstallPage
Var RelayInstallTitle
Var RelayInstallProgress
Var RelayInstallFont
Var RelayInstallTitleFont
Var RelayInstallSubtitleFont

Function RelayStyleInstallPage
  ${If} ${Silent}
    Return
  ${EndIf}

  ; MUI's install page is a child dialog of the main NSIS window.
  FindWindow $RelayInstallPage "#32770" "" $HWNDPARENT

  ; Compact Relay-style window. SWP_NOMOVE | SWP_NOZORDER keeps it centered.
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i 560, i 250, i 0x0006)'

  ; Use Relay's neutral surface and typography instead of the legacy NSIS look.
  SetCtlColors $HWNDPARENT 202124 FFFFFF
  ${If} $RelayInstallPage != 0
    SetCtlColors $RelayInstallPage 202124 FFFFFF
    System::Call 'user32::SetWindowPos(p $RelayInstallPage, p 0, i 32, i 108, i 496, i 82, i 0x0004)'
  ${EndIf}

  CreateFont $RelayInstallFont "Microsoft YaHei UI" 10 400
  CreateFont $RelayInstallTitleFont "Microsoft YaHei UI" 17 600
  CreateFont $RelayInstallSubtitleFont "Microsoft YaHei UI" 10 400

  ; Remove legacy wizard chrome, buttons, separators and NSIS branding.
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1036
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 ${SW_HIDE}

  ; Reuse MUI's header controls as Relay's title and subtitle.
  GetDlgItem $0 $HWNDPARENT 1034
  System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i 560, i 222, i 0x0004)'
  SetCtlColors $0 202124 FFFFFF

  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:正在安装 Relay"
  SendMessage $0 ${WM_SETFONT} $RelayInstallTitleFont 0
  SetCtlColors $0 202124 FFFFFF
  System::Call 'user32::SetWindowPos(p r0, p 0, i 32, i 38, i 496, i 30, i 0x0004)'

  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:请稍候，安装完成后将自动启动。"
  SendMessage $0 ${WM_SETFONT} $RelayInstallSubtitleFont 0
  SetCtlColors $0 70757D FFFFFF
  System::Call 'user32::SetWindowPos(p r0, p 0, i 32, i 72, i 496, i 22, i 0x0004)'

  GetDlgItem $RelayInstallTitle $RelayInstallPage 1006
  ${If} $RelayInstallTitle == 0
    GetDlgItem $RelayInstallTitle $HWNDPARENT 1006
  ${EndIf}
  ${If} $RelayInstallTitle != 0
    SendMessage $RelayInstallTitle ${WM_SETTEXT} 0 "STR:正在准备所需组件…"
    SendMessage $RelayInstallTitle ${WM_SETFONT} $RelayInstallFont 0
    SetCtlColors $RelayInstallTitle 565B64 FFFFFF
    System::Call 'user32::SetWindowPos(p $RelayInstallTitle, p 0, i 0, i 0, i 496, i 20, i 0x0004)'
  ${EndIf}

  GetDlgItem $RelayInstallProgress $RelayInstallPage 1004
  ${If} $RelayInstallProgress == 0
    GetDlgItem $RelayInstallProgress $HWNDPARENT 1004
  ${EndIf}
  ${If} $RelayInstallProgress != 0
    ; Disable the system's green progress theme, then apply Relay blue.
    System::Call 'UxTheme::SetWindowTheme(p $RelayInstallProgress, w "", w "")'
    SendMessage $RelayInstallProgress ${PBM_SETBARCOLOR} 0 0x00EB6F1F
    SendMessage $RelayInstallProgress ${PBM_SETBKCOLOR} 0 0x00F2EEE9
    System::Call 'user32::SetWindowPos(p $RelayInstallProgress, p 0, i 0, i 32, i 496, i 10, i 0x0004)'
  ${EndIf}

  GetDlgItem $0 $RelayInstallPage 1027
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $RelayInstallPage 1016
  ShowWindow $0 ${SW_HIDE}
FunctionEnd
!endif

; Skip the assisted install-mode choice and keep the current-user behavior.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; This hook runs immediately before MUI_PAGE_INSTFILES is declared.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW RelayStyleInstallPage
!macroend

; Launch Relay and immediately quit the installer — no finish page.
!macro customInstall
  ${IfNot} ${Silent}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  ${EndIf}
  Quit
!macroend

!macro customFinishPage
!macroend

!macro customHeader
  BrandingText "Relay"
!macroend
