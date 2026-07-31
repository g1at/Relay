; ─────────────────────────────────────────────────────────────
;  installer-ui.nsh — 把 NSIS 的安装进度页重绘成极简风格
;
;  版式:纯白单层画布,内容垂直居中偏上
;      ┌──────────────────────────┐
;      │                          │
;      │          [ logo ]        │   256px 图标缩放绘制
;      │           Relay          │   20px / 600
;      │                          │
;      │      ▓▓▓▓▓░░░░░░░░░      │   8px 进度条
;      │        正在安装…         │   13px #8A8A8A
;      └──────────────────────────┘
;
;  取色沿用 installer/wizard.css,保证与应用内首次设置向导同一套视觉语言。
;
;  两个关键实现点:
;   1) DPI —— NSIS 默认不声明 DPI 感知,系统会把整窗位图拉伸,高分屏上字发虚。
;      这里声明 ManifestDPIAware 拿到物理像素画布,再用 $RelayDPI 把所有
;      硬编码坐标按 96 DPI 基准换算。字号交给 NSIS 的 CreateFont(它按点值
;      自行乘 LOGPIXELSY),不需要手动缩放。
;   2) Logo —— 直接 LoadImage 加载 icon.ico 并指定目标像素尺寸,由系统挑选
;      最接近的内嵌位图(本图标含 256×256/32bpp)并做带 alpha 的缩放,
;      省去为每档 DPI 预生成位图。
;
;  调用方需先 !define RELAY_UI_ICON 指向 .ico 路径。
; ─────────────────────────────────────────────────────────────

!include "WinMessages.nsh"
!include "LogicLib.nsh"

!ifndef RELAY_UI_INCLUDED
!define RELAY_UI_INCLUDED

; 拿物理像素画布,否则高分屏下整窗被系统拉伸,文字糊成一团
ManifestDPIAware true

; ── 取色(对齐 wizard.css)──
!define RELAY_SURFACE     FFFFFF   ; 单层画布,不再分 header / body
!define RELAY_TEXT        1A1A1A   ; --text
!define RELAY_TEXT_MUTED  8A8A8A   ; --text-muted
; PBM_SETxxCOLOR 收 COLORREF(0x00BBGGRR),字节序与 SetCtlColors 的 RRGGBB 相反
!define RELAY_ACCENT_BGR  0x00EB6F1F   ; --accent  #1F6FEB
!define RELAY_TRACK_BGR   0x00EFEDED   ; 轨道灰    #EDEDEF

; ── 版式(96 DPI 基准的客户区逻辑像素)──
!define RELAY_W        640
!define RELAY_H        380
!define RELAY_LOGO     112
!define RELAY_LOGO_Y   78
!define RELAY_NAME_Y   208
!define RELAY_NAME_H   32
!define RELAY_BAR_W    400
!define RELAY_BAR_Y    290
!define RELAY_BAR_H    8
!define RELAY_TEXT_Y   314
!define RELAY_TEXT_H   22

; ── Win32 常量 ──
!define RELAY_S_CENTER     0x50000201   ; WS_CHILD|WS_VISIBLE|SS_CENTER|SS_CENTERIMAGE
!define RELAY_S_ICON       0x50000243   ; WS_CHILD|WS_VISIBLE|SS_ICON|SS_REALSIZECONTROL|SS_CENTERIMAGE
!define RELAY_STM_SETIMAGE 0x0172
!define RELAY_IMAGE_ICON   1
!define RELAY_LR_FROMFILE  0x10
!define RELAY_PBM_BARCOLOR 0x409
!define RELAY_PBM_BKCOLOR  0x2001
!define RELAY_GWL_STYLE    -16
!define RELAY_SPI_WORKAREA 48

Var RelayPage      ; MUI 进度页(主窗下的子对话框)
Var RelayDPI
Var RelayCW        ; 客户区宽(物理像素)
Var RelayCtl
Var RelayFontName
Var RelayFontHint

; 逻辑像素 → 物理像素
!macro RelayPx OUT V
  IntOp ${OUT} ${V} * $RelayDPI
  IntOp ${OUT} ${OUT} / 96
!macroend

!macro RelayMakeCtl TEXT X Y W H STYLE
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "${TEXT}", \
      i ${STYLE}, i ${X}, i ${Y}, i ${W}, i ${H}, \
      p $HWNDPARENT, p 0, p 0, p 0) p .s'
  Pop $RelayCtl
!macroend

; 整行居中的文本
!macro RelayCenterText TEXT Y H FONT FG
  !insertmacro RelayPx $2 ${Y}
  !insertmacro RelayPx $3 ${H}
  !insertmacro RelayMakeCtl "${TEXT}" 0 $2 $RelayCW $3 ${RELAY_S_CENTER}
  SendMessage $RelayCtl ${WM_SETFONT} ${FONT} 1
  SetCtlColors $RelayCtl ${FG} ${RELAY_SURFACE}
!macroend

; 隐藏 $HWNDPARENT 上的原生控件($0 会被覆写)
!macro RelayHide ID
  GetDlgItem $0 $HWNDPARENT ${ID}
  ShowWindow $0 ${SW_HIDE}
!macroend

; ─────────────────────────────────────────────────────────────
;  RelayStyleInstallPage —— 挂到 MUI_PAGE_INSTFILES 的 SHOW 回调
; ─────────────────────────────────────────────────────────────
Function RelayStyleInstallPage
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

  FindWindow $RelayPage "#32770" "" $HWNDPARENT

  ; ── 当前 DPI ── LOGPIXELSX = 88
  System::Call 'user32::GetDC(p 0) p .r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 88) i .r1'
  System::Call 'user32::ReleaseDC(p 0, p r0) i'
  ${If} $1 < 96
    StrCpy $1 96
  ${EndIf}
  StrCpy $RelayDPI $1

  SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Relay"
  SetCtlColors $HWNDPARENT ${RELAY_TEXT} ${RELAY_SURFACE}

  ; 去掉最大化与可拖拽边框(保留最小化),对齐向导窗口的 resizable:false
  System::Call 'user32::GetWindowLong(p $HWNDPARENT, i ${RELAY_GWL_STYLE}) i .r0'
  IntOp $0 $0 & 0xFFFAFFFF
  System::Call 'user32::SetWindowLong(p $HWNDPARENT, i ${RELAY_GWL_STYLE}, i r0)'

  ; ── 定尺寸 ──
  ;    SetWindowPos 设的是含标题栏/边框的外框,先量一次实际客户区,
  ;    把差额补回去,保证客户区正好是设计稿尺寸。
  !insertmacro RelayPx $4 ${RELAY_W}
  !insertmacro RelayPx $5 ${RELAY_H}
  ; SWP_NOMOVE|SWP_NOZORDER|SWP_FRAMECHANGED
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r4, i r5, i 0x0026)'

  System::Alloc 16
  Pop $1
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r1)'
  System::Call '*$1(i, i, i .r2, i .r3)'
  System::Free $1
  IntOp $4 $4 * 2
  IntOp $4 $4 - $2          ; outerW + (designW - clientW)
  IntOp $5 $5 * 2
  IntOp $5 $5 - $3
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r4, i r5, i 0x0026)'

  ; ── 在工作区内重新居中(前面的 SWP_NOMOVE 只保住了左上角)──
  System::Alloc 16
  Pop $1
  System::Call 'user32::SystemParametersInfo(i ${RELAY_SPI_WORKAREA}, i 0, p r1, i 0)'
  System::Call '*$1(i .r2, i .r3, i .r0, i .r6)'   ; left, top, right, bottom
  System::Free $1
  ; x = left + (工作区宽 - 窗口宽) / 2
  IntOp $0 $0 - $2
  IntOp $0 $0 - $4
  IntOp $0 $0 / 2
  IntOp $0 $0 + $2
  ; y 取 42%(而非 50%),视觉重心略高更稳
  IntOp $6 $6 - $3
  IntOp $6 $6 - $5
  IntOp $6 $6 * 42
  IntOp $6 $6 / 100
  IntOp $6 $6 + $3
  ; SWP_NOSIZE|SWP_NOZORDER
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r6, i 0, i 0, i 0x0005)'

  !insertmacro RelayPx $RelayCW ${RELAY_W}

  ; ── 抹掉 MUI 的原生外观:按钮、页眉、分隔线、NSIS 品牌 ──
  !insertmacro RelayHide 1      ; 安装 / 关闭
  !insertmacro RelayHide 2      ; 取消
  !insertmacro RelayHide 3      ; 上一步
  !insertmacro RelayHide 1028   ; "Nullsoft Install System"
  !insertmacro RelayHide 1256   ; branding image
  !insertmacro RelayHide 1035
  !insertmacro RelayHide 1036
  !insertmacro RelayHide 1045   ; 底部分隔线
  !insertmacro RelayHide 1039   ; 页眉图标
  !insertmacro RelayHide 1034   ; 页眉白底
  !insertmacro RelayHide 1037   ; 页眉标题(安装结束会被 MUI 改写成「安装完成」,弃用)
  !insertmacro RelayHide 1038   ; 页眉副标题

  ; ── 字体 ── CreateFont 的字号是点值,NSIS 内部已按 LOGPIXELSY 换算
  CreateFont $RelayFontName "Microsoft YaHei UI" 15 600
  CreateFont $RelayFontHint "Microsoft YaHei UI" 10 400

  ; ── Logo ── 从 .ico 里取最接近目标尺寸的内嵌位图,带 alpha 缩放
  InitPluginsDir
  File "/oname=$PLUGINSDIR\relay-logo.ico" "${RELAY_UI_ICON}"
  !insertmacro RelayPx $2 ${RELAY_LOGO}
  !insertmacro RelayPx $3 ${RELAY_LOGO_Y}
  IntOp $1 $RelayCW - $2
  IntOp $1 $1 / 2
  !insertmacro RelayMakeCtl "" $1 $3 $2 $2 ${RELAY_S_ICON}
  SetCtlColors $RelayCtl ${RELAY_TEXT} ${RELAY_SURFACE}
  StrCpy $1 $RelayCtl
  System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\relay-logo.ico", \
      i ${RELAY_IMAGE_ICON}, i r2, i r2, i ${RELAY_LR_FROMFILE}) p .r0'
  SendMessage $1 ${RELAY_STM_SETIMAGE} ${RELAY_IMAGE_ICON} $0

  ; ── 产品名 + 状态行 ──
  !insertmacro RelayCenterText "Relay" ${RELAY_NAME_Y} ${RELAY_NAME_H} \
      $RelayFontName ${RELAY_TEXT}
  !insertmacro RelayCenterText "正在安装，请稍候…" ${RELAY_TEXT_Y} ${RELAY_TEXT_H} \
      $RelayFontHint ${RELAY_TEXT_MUTED}

  ; ── 进度条 ──
  ;    把 MUI 子对话框整体缩成进度条那一条,原地复用它的控件 1004,
  ;    这样 NSIS 仍按自己的节奏驱动进度,不需要额外的定时器。
  ${If} $RelayPage != 0
    SetCtlColors $RelayPage ${RELAY_TEXT} ${RELAY_SURFACE}
    !insertmacro RelayPx $2 ${RELAY_BAR_W}
    !insertmacro RelayPx $3 ${RELAY_BAR_H}
    !insertmacro RelayPx $4 ${RELAY_BAR_Y}
    ; 摘掉主题后控件会退回经典外观,自己画 1px 凹边框。这里把控件放大 1px 一圈,
    ; 再用内缩 1px 的圆角区域把边框连同方角一并裁掉,只留纯色轨道与填充。
    IntOp $5 $3 + 2
    IntOp $4 $4 - 1
    IntOp $1 $RelayCW - $2
    IntOp $1 $1 / 2
    ; SWP_NOZORDER
    System::Call 'user32::SetWindowPos(p $RelayPage, p 0, i r1, i r4, i r2, i r5, i 0x0004)'

    ; 状态行「Extract: xxx.pak」和日志框太技术化,隐藏
    GetDlgItem $1 $RelayPage 1006
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $RelayPage 1016
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $RelayPage 1027
    ShowWindow $1 ${SW_HIDE}

    GetDlgItem $1 $RelayPage 1004
    ${If} $1 != 0
      ; 必须先摘掉系统主题,否则绿色主题条会无视 PBM_SETBARCOLOR
      System::Call 'UxTheme::SetWindowTheme(p $1, w "", w "")'
      SendMessage $1 ${RELAY_PBM_BARCOLOR} 0 ${RELAY_ACCENT_BGR}
      SendMessage $1 ${RELAY_PBM_BKCOLOR}  0 ${RELAY_TRACK_BGR}
      System::Call 'user32::SetWindowPos(p $1, p 0, i 0, i 0, i r2, i r5, i 0x0004)'
      IntOp $0 $2 - 1
      IntOp $4 $5 - 1
      System::Call 'gdi32::CreateRoundRectRgn(i 1, i 1, i r0, i r4, i r3, i r3) p .r5'
      System::Call 'user32::SetWindowRgn(p $1, p r5, i 1) i'
    ${EndIf}

    ; 裁掉的圆角处仍留着控件上一帧的像素,必须让直接父窗口连同子控件重画一次。
    ; RDW_INVALIDATE|RDW_ERASE|RDW_ALLCHILDREN|RDW_UPDATENOW
    System::Call 'user32::RedrawWindow(p $RelayPage, p 0, p 0, i 0x0185) i'
  ${EndIf}

  ; 子对话框搬家后原位置留脏区,整窗重绘一次
  System::Call 'user32::InvalidateRect(p $HWNDPARENT, p 0, i 1)'

  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!endif ; RELAY_UI_INCLUDED
