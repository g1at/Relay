; Relay native installer and uninstaller presentation.
; The NSIS engine's 1004 range is an instruction counter, not an end-to-end
; work total. Extraction and old-version removal can reset it. Do not expose
; that value as a percentage or advance progress on a timer. An independent
; indeterminate control is used until the operation reports real success.
!ifndef RELAY_UI_INCLUDED
!define RELAY_UI_INCLUDED
!include "WinMessages.nsh"
!include "LogicLib.nsh"
ManifestDPIAware true
!ifndef RELAY_UI_SKIN
  !define RELAY_UI_SKIN "${__FILEDIR__}\installer-skin\relay-installer-skin.dll"
!endif

!ifdef BUILD_UNINSTALLER
  !define RELAY_UI_PREFIX "un."
  !define RELAY_UI_ACTION "卸载"
!else
  !define RELAY_UI_PREFIX ""
  !define RELAY_UI_ACTION "安装"
!endif

!define RELAY_SURFACE FFFFFF
!define RELAY_TEXT 1B1C1E
!define RELAY_TEXT_MUTED 72757C
!define RELAY_ACCENT_BGR 0x00FD6B24
!define RELAY_TRACK_BGR 0x00F4F0EE
!define RELAY_ERROR_BGR 0x004A43C2
!define RELAY_W 620
!define RELAY_H 420
!define RELAY_PBM_SETMARQUEE 0x040A
!define RELAY_PBM_SETPOS 0x0402
!define RELAY_PBM_SETRANGE32 0x0406
!define RELAY_PBM_BARCOLOR 0x0409
!define RELAY_PBM_BKCOLOR 0x2001

Var RelayPage
Var RelayDPI
Var RelayProgress
Var RelayStage
Var RelayTitle
Var RelaySubtitle
Var RelayLocation
Var RelayLogoCtl
Var RelayLogoImage
Var RelayFontTitle
Var RelayFontBody
Var RelayFontSmall
Var RelayUIState
Var RelayPendingStage
Var RelaySkinModule
Var RelaySkinAttachProc
Var RelaySkinRefreshProc
Var RelaySkinDestroyProc
Var RelaySkinAttempted
Var RelaySkinAttached
; Set to "delete" only for an explicit --delete-app-data uninstall.
!ifdef BUILD_UNINSTALLER
Var RelayUIDataPolicy
!endif

!macro RelayPx OUT V
  IntOp ${OUT} ${V} * $RelayDPI
  IntOp ${OUT} ${OUT} / 96
!macroend

; Scratch registers are saved by every public function that uses these macros.
!macro RelayMove HANDLE X Y W H
  !insertmacro RelayPx $1 ${X}
  !insertmacro RelayPx $2 ${Y}
  !insertmacro RelayPx $3 ${W}
  !insertmacro RelayPx $4 ${H}
  System::Call 'user32::SetWindowPos(p ${HANDLE}, p 0, i r1, i r2, i r3, i r4, i 0x0014)'
!macroend

!macro RelayLabel OUT TEXT X Y W H FONT
  !insertmacro RelayPx $1 ${X}
  !insertmacro RelayPx $2 ${Y}
  !insertmacro RelayPx $3 ${W}
  !insertmacro RelayPx $4 ${H}
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "${TEXT}", i 0x50000000, i r1, i r2, i r3, i r4, p $HWNDPARENT, p 0, p 0, p 0) p .s'
  Pop ${OUT}
  SendMessage ${OUT} ${WM_SETFONT} ${FONT} 1
  SetCtlColors ${OUT} ${RELAY_TEXT_MUTED} ${RELAY_SURFACE}
!macroend

; The skin is a presentation layer over NSIS controls and messages. Failure
; to load/attach leaves the standard native buttons and title bar functional.
Function ${RELAY_UI_PREFIX}RelayUILoadSkin
  ${If} ${Silent}
    Return
  ${EndIf}
  ${If} $RelaySkinAttempted == "1"
    Return
  ${EndIf}
  StrCpy $RelaySkinAttempted "1"
  Push $0
  InitPluginsDir
  File "/oname=$PLUGINSDIR\relay-installer-skin.dll" "${RELAY_UI_SKIN}"
  System::Call 'kernel32::LoadLibraryW(w "$PLUGINSDIR\relay-installer-skin.dll") p .s'
  Pop $RelaySkinModule
  ${If} $RelaySkinModule != 0
    System::Call 'kernel32::GetProcAddress(p $RelaySkinModule, m "RelaySkinAttach") p .s'
    Pop $RelaySkinAttachProc
    System::Call 'kernel32::GetProcAddress(p $RelaySkinModule, m "RelaySkinRefresh") p .s'
    Pop $RelaySkinRefreshProc
    System::Call 'kernel32::GetProcAddress(p $RelaySkinModule, m "RelaySkinDestroy") p .s'
    Pop $RelaySkinDestroyProc
    ${If} $RelaySkinAttachProc != 0
    ${AndIf} $RelaySkinRefreshProc != 0
    ${AndIf} $RelaySkinDestroyProc != 0
      System::Call '::$RelaySkinAttachProc(p $HWNDPARENT, i $RelayDPI) i .r0'
      ${If} $0 != 0
        StrCpy $RelaySkinAttached "1"
      ${Else}
        System::Call '::$RelaySkinDestroyProc(p $HWNDPARENT)'
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

Function ${RELAY_UI_PREFIX}RelayUIRefreshSkin
  ${If} ${Silent}
    Return
  ${EndIf}
  ${If} $RelaySkinAttached == "1"
    System::Call '::$RelaySkinRefreshProc(p $HWNDPARENT)'
  ${EndIf}
FunctionEnd

; Invoke from the GUI-end hook while the native parent still exists. Keep the
; module mapped through process teardown so queued window messages can never
; jump into an unloaded subclass procedure.
Function ${RELAY_UI_PREFIX}RelayUIDestroy
  ${If} $RelaySkinAttached == "1"
    System::Call '::$RelaySkinDestroyProc(p $HWNDPARENT)'
    StrCpy $RelaySkinAttached "0"
  ${EndIf}
FunctionEnd

; One brand frame persists across pages. Native navigation is deliberately
; retained: cancellation, errors and completion must always have an exit path.
Function ${RELAY_UI_PREFIX}RelayUIFrame
  ${If} ${Silent}
    Return
  ${EndIf}
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ${If} $RelayDPI == ""
    System::Call 'user32::GetDC(p $HWNDPARENT) p .r0'
    System::Call 'gdi32::GetDeviceCaps(p r0, i 88) i .r1'
    System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
    ${If} $1 < 96
      StrCpy $1 96
    ${EndIf}
    StrCpy $RelayDPI $1
    CreateFont $RelayFontTitle "Microsoft YaHei UI" 16 600
    CreateFont $RelayFontBody "Microsoft YaHei UI" 10 400
    CreateFont $RelayFontSmall "Microsoft YaHei UI" 9 400

    ; Adjust the outer rectangle once, preserving an exact DPI-scaled client
    ; area; do not compound the frame delta every time a page is shown.
    !insertmacro RelayPx $4 ${RELAY_W}
    !insertmacro RelayPx $5 ${RELAY_H}
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r4, i r5, i 0x0026)'
    System::Alloc 16
    Pop $0
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p r0)'
    System::Call '*$0(i, i, i .r2, i .r3)'
    System::Free $0
    IntOp $4 $4 * 2
    IntOp $4 $4 - $2
    IntOp $5 $5 * 2
    IntOp $5 $5 - $3
    System::Alloc 16
    Pop $0
    System::Call 'user32::SystemParametersInfo(i 48, i 0, p r0, i 0)'
    System::Call '*$0(i .r1, i .r2, i .r3, i .r6)'
    System::Free $0
    IntOp $3 $3 - $1
    IntOp $3 $3 - $4
    IntOp $3 $3 / 2
    IntOp $1 $1 + $3
    IntOp $6 $6 - $2
    IntOp $6 $6 - $5
    IntOp $6 $6 / 2
    IntOp $2 $2 + $6
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r1, i r2, i r4, i r5, i 0x0024)'
    SetCtlColors $HWNDPARENT ${RELAY_TEXT} ${RELAY_SURFACE}
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Relay ${RELAY_UI_ACTION}"

    InitPluginsDir
    File "/oname=$PLUGINSDIR\relay-setup-logo.ico" "${RELAY_UI_ICON}"
    !insertmacro RelayPx $1 48
    !insertmacro RelayPx $2 40
    !insertmacro RelayPx $3 56
    System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x50000243, i r1, i r2, i r3, i r3, p $HWNDPARENT, p 0, p 0, p 0) p .s'
    Pop $RelayLogoCtl
    SetCtlColors $RelayLogoCtl ${RELAY_TEXT} ${RELAY_SURFACE}
    System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\relay-setup-logo.ico", i 1, i r3, i r3, i 0x10) p .s'
    Pop $RelayLogoImage
    SendMessage $RelayLogoCtl 0x0172 1 $RelayLogoImage
    !insertmacro RelayLabel $RelayTitle "${RELAY_UI_ACTION} Relay" 122 40 450 36 $RelayFontTitle
    SetCtlColors $RelayTitle ${RELAY_TEXT} ${RELAY_SURFACE}
    !insertmacro RelayLabel $RelaySubtitle "" 122 80 450 30 $RelayFontBody
    !insertmacro RelayLabel $RelayStage "" 48 146 524 30 $RelayFontBody
    SetCtlColors $RelayStage ${RELAY_TEXT} ${RELAY_SURFACE}
    !insertmacro RelayLabel $RelayLocation "" 48 160 524 112 $RelayFontBody
  ${EndIf}

  ; Remove the old MUI header and separators, never the action buttons.
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1034
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1036
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  !insertmacro RelayMove $0 460 366 112 34
  SendMessage $0 ${WM_SETFONT} $RelayFontBody 1
  GetDlgItem $0 $HWNDPARENT 2
  !insertmacro RelayMove $0 340 366 108 34
  SendMessage $0 ${WM_SETFONT} $RelayFontBody 1
  GetDlgItem $0 $HWNDPARENT 3
  !insertmacro RelayMove $0 48 366 108 34
  SendMessage $0 ${WM_SETFONT} $RelayFontBody 1
  Call ${RELAY_UI_PREFIX}RelayUILoadSkin
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${RELAY_UI_PREFIX}RelayStyleInstallPage
  ${If} ${Silent}
    Return
  ${EndIf}
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Call ${RELAY_UI_PREFIX}RelayUIFrame
  FindWindow $RelayPage "#32770" "" $HWNDPARENT
  StrCpy $RelayUIState "working"
  ; Back/Next do not apply while NSIS owns an active operation. Keep its
  ; Cancel state intact; terminal handlers restore the proper close action.
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  SendMessage $RelayTitle ${WM_SETTEXT} 0 "STR:正在${RELAY_UI_ACTION} Relay"
  SendMessage $RelaySubtitle ${WM_SETTEXT} 0 "STR:完成后会在这里显示结果。"
  ShowWindow $RelayLocation ${SW_HIDE}
  ShowWindow $RelayStage ${SW_SHOW}
  ${If} $RelayPendingStage == ""
    !ifdef BUILD_UNINSTALLER
      StrCpy $RelayPendingStage "正在准备卸载…"
    !else
      StrCpy $RelayPendingStage "正在安装应用及相关组件…"
    !endif
  ${EndIf}
  SendMessage $RelayStage ${WM_SETTEXT} 0 "STR:$RelayPendingStage"
  !insertmacro RelayMove $RelayPage 48 198 524 154
  SetCtlColors $RelayPage ${RELAY_TEXT} ${RELAY_SURFACE}

  ; NSIS remains in charge of execution/logs but cannot repaint our bar.
  GetDlgItem $0 $RelayPage 1004
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $RelayPage 1006
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $RelayPage 1027
  !insertmacro RelayMove $0 0 0 112 28
  SendMessage $0 ${WM_SETTEXT} 0 "STR:查看详细信息"
  SendMessage $0 ${WM_SETFONT} $RelayFontSmall 1
  GetDlgItem $0 $RelayPage 1016
  !insertmacro RelayMove $0 0 34 524 120
  SendMessage $0 ${WM_SETFONT} $RelayFontSmall 1
  ; ListView text/background colors (COLORREF), retaining keyboard selection.
  SendMessage $0 0x1001 0 0x00FFFFFF
  SendMessage $0 0x1024 0 0x005F5B57
  SendMessage $0 0x1026 0 0x00FFFFFF
  SetDetailsView hide

  ${If} $RelayProgress == ""
    !insertmacro RelayPx $1 48
    !insertmacro RelayPx $2 176
    !insertmacro RelayPx $3 524
    !insertmacro RelayPx $4 6
    ; PBS_MARQUEE: animation denotes activity, never elapsed-time completion.
    System::Call 'user32::CreateWindowEx(i 0, t "msctls_progress32", t "", i 0x50000008, i r1, i r2, i r3, i r4, p $HWNDPARENT, p 0, p 0, p 0) p .s'
    Pop $RelayProgress
    System::Call 'UxTheme::SetWindowTheme(p $RelayProgress, w "", w "")'
    SendMessage $RelayProgress ${RELAY_PBM_BARCOLOR} 0 ${RELAY_ACCENT_BGR}
    SendMessage $RelayProgress ${RELAY_PBM_BKCOLOR} 0 ${RELAY_TRACK_BGR}
    ; Rounded clipping uses physical pixel dimensions, including high DPI.
    System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r3, i r4, i r4, i r4) p .r0'
    System::Call 'user32::SetWindowRgn(p $RelayProgress, p r0, i 1)'
  ${EndIf}
  ShowWindow $RelayProgress ${SW_SHOW}
  SendMessage $RelayProgress ${RELAY_PBM_SETMARQUEE} 1 28
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x0185)'
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Call ${RELAY_UI_PREFIX}RelayUIRefreshSkin
FunctionEnd

; Caller supplies a real lifecycle stage; there is no percentage estimate.
Function ${RELAY_UI_PREFIX}RelayUISetStage
  Exch $0
  StrCpy $RelayPendingStage $0
  ${If} $RelayUIState == "working"
    SendMessage $RelayStage ${WM_SETTEXT} 0 "STR:$0"
  ${EndIf}
  DetailPrint "$0"
  Pop $0
FunctionEnd

Function ${RELAY_UI_PREFIX}RelayUISuccess
  ${If} $RelayUIState == "failed"
    Return
  ${EndIf}
  StrCpy $RelayUIState "success"
  ${IfNot} ${Silent}
    SendMessage $RelayProgress ${RELAY_PBM_SETMARQUEE} 0 0
    ; Remove PBS_MARQUEE before setting a determinate final position.
    Push $0
    System::Call 'user32::GetWindowLong(p $RelayProgress, i -16) i .r0'
    IntOp $0 $0 & 0xFFFFFFF7
    System::Call 'user32::SetWindowLong(p $RelayProgress, i -16, i r0)'
    Pop $0
    SendMessage $RelayProgress ${RELAY_PBM_SETRANGE32} 0 100
    SendMessage $RelayProgress ${RELAY_PBM_SETPOS} 100 0
    SendMessage $RelayTitle ${WM_SETTEXT} 0 "STR:${RELAY_UI_ACTION}完成"
    SendMessage $RelayStage ${WM_SETTEXT} 0 "STR:所有步骤已完成。"
    Push $0
    GetDlgItem $0 $HWNDPARENT 1
    ShowWindow $0 ${SW_SHOW}
    EnableWindow $0 1
    Pop $0
  ${EndIf}
  Call ${RELAY_UI_PREFIX}RelayUIRefreshSkin
FunctionEnd

Function ${RELAY_UI_PREFIX}RelayUIFailure
  StrCpy $RelayUIState "failed"
  ${IfNot} ${Silent}
    SendMessage $RelayProgress ${RELAY_PBM_SETMARQUEE} 0 0
    SendMessage $RelayProgress ${RELAY_PBM_BARCOLOR} 0 ${RELAY_ERROR_BGR}
    SendMessage $RelayTitle ${WM_SETTEXT} 0 "STR:${RELAY_UI_ACTION}未完成"
    SendMessage $RelaySubtitle ${WM_SETTEXT} 0 "STR:请查看下方详细信息，然后关闭此窗口。"
    SendMessage $RelayStage ${WM_SETTEXT} 0 "STR:发生错误，${RELAY_UI_ACTION}已停止。"
    SetCtlColors $RelayStage C2434A ${RELAY_SURFACE}
    SetDetailsView show
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    ; In an aborted NSIS section IDCANCEL closes the installer; IDOK still
    ; means Next and cannot close reliably even if enabled and relabelled.
    GetDlgItem $0 $HWNDPARENT 1
    ShowWindow $0 ${SW_HIDE}
    GetDlgItem $0 $HWNDPARENT 2
    !insertmacro RelayMove $0 460 366 112 34
    SendMessage $0 ${WM_SETTEXT} 0 "STR:关闭"
    ShowWindow $0 ${SW_SHOW}
    EnableWindow $0 1
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
  Call ${RELAY_UI_PREFIX}RelayUIRefreshSkin
FunctionEnd

; Welcome/finish pages retain their native checkboxes, reboot choices and
; navigation handlers. Only decorative STATIC controls are replaced.
Function ${RELAY_UI_PREFIX}RelayStyleStandardPage
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ; nsDialogs creates the new welcome/finish dialog before destroying the
  ; previous instfiles page. FindWindow alone may return that older page.
  ; Identify the newly created standard MUI page by its image control (1200).
  StrCpy $RelayPage 0
  StrCpy $5 0
  ${Do}
    FindWindow $5 "#32770" "" $HWNDPARENT $5
    ${If} $5 == 0
      ${ExitDo}
    ${EndIf}
    GetDlgItem $0 $5 1200
    ${If} $0 != 0
      StrCpy $RelayPage $5
    ${EndIf}
  ${Loop}
  !insertmacro RelayMove $RelayPage 48 286 524 68
  SetCtlColors $RelayPage ${RELAY_TEXT} ${RELAY_SURFACE}
  System::Call 'user32::GetWindow(p $RelayPage, i 5) p .r5'
  StrCpy $6 0
  ${DoWhile} $5 != 0
    System::Call 'user32::GetClassName(p r5, t .r0, i ${NSIS_MAX_STRLEN})'
    ${If} $0 == "Static"
      ShowWindow $5 ${SW_HIDE}
    ${ElseIf} $0 == "Button"
      !insertmacro RelayMove $5 0 $6 524 28
      SendMessage $5 ${WM_SETFONT} $RelayFontBody 1
      SetCtlColors $5 ${RELAY_TEXT} ${RELAY_SURFACE}
      IntOp $6 $6 + 30
    ${EndIf}
    System::Call 'user32::GetWindow(p r5, i 2) p .r5'
  ${Loop}
  ShowWindow $RelayProgress ${SW_HIDE}
  ShowWindow $RelayStage ${SW_HIDE}
  ShowWindow $RelayLocation ${SW_SHOW}
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x0185)'
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ${RELAY_UI_PREFIX}RelayStyleWelcomePage
  ${If} ${Silent}
    Return
  ${EndIf}
  Call ${RELAY_UI_PREFIX}RelayUIFrame
  Call ${RELAY_UI_PREFIX}RelayStyleStandardPage
  SendMessage $RelayTitle ${WM_SETTEXT} 0 "STR:${RELAY_UI_ACTION} Relay"
  !ifdef BUILD_UNINSTALLER
    ${If} $RelayUIDataPolicy == "delete"
      SendMessage $RelaySubtitle ${WM_SETTEXT} 0 "STR:移除应用并清理本地应用数据。"
      SendMessage $RelayLocation ${WM_SETTEXT} 0 "STR:即将移除以下位置的 Relay：$\r$\n$INSTDIR$\r$\n$\r$\n本次已指定清理本地会话和设置。"
    ${Else}
      SendMessage $RelaySubtitle ${WM_SETTEXT} 0 "STR:移除应用，保留您的个人数据。"
      SendMessage $RelayLocation ${WM_SETTEXT} 0 "STR:即将移除以下位置的 Relay：$\r$\n$INSTDIR$\r$\n$\r$\n安装目录外的会话、设置与项目文件会保留。"
    ${EndIf}
  !else
    SendMessage $RelaySubtitle ${WM_SETTEXT} 0 "STR:让本地 AI 助手准备就绪。"
    SendMessage $RelayLocation ${WM_SETTEXT} 0 "STR:安装位置$\r$\n$INSTDIR$\r$\n$\r$\n安装目录外的会话、设置与项目文件会保留。"
  !endif
  Push $0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:${RELAY_UI_ACTION}"
  Pop $0
  Call ${RELAY_UI_PREFIX}RelayUIRefreshSkin
FunctionEnd

Function ${RELAY_UI_PREFIX}RelayStyleFinishPage
  ${If} ${Silent}
    Return
  ${EndIf}
  Call ${RELAY_UI_PREFIX}RelayUIFrame
  Call ${RELAY_UI_PREFIX}RelayStyleStandardPage
  ${If} $RelayUIState == "failed"
    SendMessage $RelayTitle ${WM_SETTEXT} 0 "STR:${RELAY_UI_ACTION}未完成"
    Return
  ${EndIf}
  Push $0
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  Pop $0
  SendMessage $RelayTitle ${WM_SETTEXT} 0 "STR:${RELAY_UI_ACTION}完成"
  !ifdef BUILD_UNINSTALLER
    SendMessage $RelaySubtitle ${WM_SETTEXT} 0 "STR:Relay 已从此电脑移除。"
    ${If} $RelayUIDataPolicy == "delete"
      SendMessage $RelayLocation ${WM_SETTEXT} 0 "STR:已按本次要求清理本地应用数据。$\r$\n$\r$\n您可以关闭此窗口。"
    ${Else}
      SendMessage $RelayLocation ${WM_SETTEXT} 0 "STR:安装目录外的会话、设置与项目文件已保留。$\r$\n$\r$\n您可以关闭此窗口。"
    ${EndIf}
  !else
    SendMessage $RelaySubtitle ${WM_SETTEXT} 0 "STR:Relay 已准备就绪。"
    SendMessage $RelayLocation ${WM_SETTEXT} 0 "STR:Relay 已安装到：$\r$\n$INSTDIR"
  !endif
  ${If} ${RebootFlag}
    SendMessage $RelaySubtitle ${WM_SETTEXT} 0 "STR:需要重新启动电脑以完成后续处理。"
  ${EndIf}
  Push $0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  Pop $0
  Call ${RELAY_UI_PREFIX}RelayUIRefreshSkin
FunctionEnd
!endif
