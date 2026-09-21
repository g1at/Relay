/* Relay's native installation presentation. NSIS retains all execution,
 * button semantics, page state, cancellation, and progress values.
 * Built for x86 without a C runtime; imports only Windows system DLLs. */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <dwmapi.h>

#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif
#ifndef SPI_GETCLIENTAREAANIMATION
#define SPI_GETCLIENTAREAANIMATION 0x1042
#endif
#define ROOT_SUBCLASS 0x524C5901
#define CHILD_SUBCLASS 0x524C5902
#define ANIMATION_TIMER 0x524C5903
#define CLOSE_ID 6201
#define SKIN_PROP L"Relay.Install.Skin.v1"
#define CHILD_PROP L"Relay.Install.Child.v1"

/* Flat GDI+ entrypoints avoid the C++ runtime and provide DPI-correct,
 * anti-aliased rounded fills. GDI continues to render native UI fonts. */
typedef void GpGraphics;
typedef void GpPath;
typedef void GpBrush;
typedef void GpPen;
typedef struct { UINT32 version; void *debug; BOOL suppressThread; BOOL suppressCodecs; } GdiStartup;
__declspec(dllimport) int WINAPI GdiplusStartup(ULONG_PTR *, const GdiStartup *, void *);
__declspec(dllimport) void WINAPI GdiplusShutdown(ULONG_PTR);
__declspec(dllimport) int WINAPI GdipCreateFromHDC(HDC,GpGraphics **);
__declspec(dllimport) int WINAPI GdipDeleteGraphics(GpGraphics *);
__declspec(dllimport) int WINAPI GdipSetSmoothingMode(GpGraphics *,int);
__declspec(dllimport) int WINAPI GdipCreateSolidFill(UINT32,GpBrush **);
__declspec(dllimport) int WINAPI GdipDeleteBrush(GpBrush *);
__declspec(dllimport) int WINAPI GdipCreatePath(int,GpPath **);
__declspec(dllimport) int WINAPI GdipAddPathArc(GpPath *,float,float,float,float,float,float);
__declspec(dllimport) int WINAPI GdipClosePathFigure(GpPath *);
__declspec(dllimport) int WINAPI GdipDeletePath(GpPath *);
__declspec(dllimport) int WINAPI GdipFillPath(GpGraphics *,GpBrush *,GpPath *);
__declspec(dllimport) int WINAPI GdipCreatePen1(UINT32,float,int,GpPen **);
__declspec(dllimport) int WINAPI GdipDeletePen(GpPen *);
__declspec(dllimport) int WINAPI GdipDrawPath(GpGraphics *,GpPen *,GpPath *);
__declspec(dllimport) int WINAPI GdipDrawLine(GpGraphics *,GpPen *,float,float,float,float);

static ULONG_PTR gdiplusToken;
static LONG rootCount;
static const COLORREF WHITE=RGB(255,255,255), TEXT=RGB(32,33,36), BLUE=RGB(36,107,253);
typedef struct {
  int dpi;
  LONG_PTR style;
  HWND close;
  HFONT brandFont;
  BOOL destroying,frameless;
} Root;
typedef struct {
  int dpi,kind;
  BOOL hover,tracking,marquee,reduced,highContrast;
  ULONGLONG epoch;
  float phase;
  COLORREF bar,track;
} Child;

static void rootChrome(HWND hwnd,Root *root);
static int px(int value,int dpi) { return MulDiv(value,dpi,96); }
static int imax(int a,int b) { return a>b?a:b; }
static int imin(int a,int b) { return a<b?a:b; }
static UINT32 argb(COLORREF c) { return 0xff000000u | ((c&0xff)<<16) | (c&0xff00) | ((c>>16)&0xff); }
static BOOL reducedMotion(void) { BOOL enabled=TRUE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,&enabled,0); return !enabled; }
static BOOL highContrast(void) { HIGHCONTRASTW c; c.cbSize=sizeof(c);c.dwFlags=0;c.lpszDefaultScheme=0;SystemParametersInfoW(SPI_GETHIGHCONTRAST,sizeof(c),&c,0);return (c.dwFlags&HCF_HIGHCONTRASTON)!=0; }
static COLORREF surface(void) { return highContrast()?GetSysColor(COLOR_WINDOW):WHITE; }
static GpGraphics *graphics(HDC dc) { GpGraphics *g=0;if(gdiplusToken&&GdipCreateFromHDC(dc,&g)==0)GdipSetSmoothingMode(g,4);return g; }
static GpPath *roundPath(float x,float y,float w,float h,float radius) {
  GpPath *p=0;float d=radius*2.0f;if(d>w)d=w;if(d>h)d=h;
  if(w<=0||h<=0||GdipCreatePath(0,&p))return 0;
  GdipAddPathArc(p,x,y,d,d,180.0f,90.0f);GdipAddPathArc(p,x+w-d,y,d,d,270.0f,90.0f);
  GdipAddPathArc(p,x+w-d,y+h-d,d,d,0.0f,90.0f);GdipAddPathArc(p,x,y+h-d,d,d,90.0f,90.0f);
  GdipClosePathFigure(p);return p;
}
static void rounded(HDC dc,GpGraphics *g,RECT rc,int radius,COLORREF fill,COLORREF line,int thickness) {
  if(rc.right<=rc.left||rc.bottom<=rc.top)return;
  if(g) {
    float inset=thickness*.5f;
    GpPath *p=roundPath(rc.left+inset,rc.top+inset,rc.right-rc.left-thickness,rc.bottom-rc.top-thickness,(float)radius);
    if(!p)return;
    if(fill!=CLR_INVALID) { GpBrush *b=0;if(!GdipCreateSolidFill(argb(fill),&b)){GdipFillPath(g,b,p);GdipDeleteBrush(b);} }
    if(line!=CLR_INVALID&&thickness>0) { GpPen *pen=0;if(!GdipCreatePen1(argb(line),(float)thickness,2,&pen)){GdipDrawPath(g,pen,p);GdipDeletePen(pen);} }
    GdipDeletePath(p);
  } else {
    HBRUSH brush=fill==CLR_INVALID?(HBRUSH)GetStockObject(NULL_BRUSH):CreateSolidBrush(fill);
    HPEN pen=line==CLR_INVALID?(HPEN)GetStockObject(NULL_PEN):CreatePen(PS_SOLID,imax(1,thickness),line);
    HGDIOBJ ob=SelectObject(dc,brush),op=SelectObject(dc,pen);
    RoundRect(dc,rc.left,rc.top,rc.right,rc.bottom,radius*2,radius*2);
    SelectObject(dc,ob);SelectObject(dc,op);if(fill!=CLR_INVALID)DeleteObject(brush);if(line!=CLR_INVALID)DeleteObject(pen);
  }
}
static void line(HDC dc,GpGraphics *g,int x1,int y1,int x2,int y2,int width,COLORREF color) {
  if(g){GpPen *p=0;if(!GdipCreatePen1(argb(color),(float)width,2,&p)){GdipDrawLine(g,p,(float)x1,(float)y1,(float)x2,(float)y2);GdipDeletePen(p);}}
  else {HPEN p=CreatePen(PS_SOLID,width,color);HGDIOBJ old=SelectObject(dc,p);MoveToEx(dc,x1,y1,0);LineTo(dc,x2,y2);SelectObject(dc,old);DeleteObject(p);}
}
static void cleanCaption(HWND hwnd,WCHAR *text,int cap) {
  int n=GetWindowTextW(hwnd,text,cap);
  /* Hide the legacy CJK '(I)' suffix visually only. Native Alt accelerators
   * and accessible window text continue to use NSIS's unchanged caption. */
  if(n>=4&&text[n-1]==L')') {
    int end=n-2;
    if(text[end]>=L'A'&&text[end]<=L'Z') {
      int start=end-1;if(start>=0&&text[start]==L'&')start--;
      if(start>=0&&text[start]==L'('){if(start>0&&text[start-1]==L' ')start--;text[start]=0;}
    }
  }
}
static void paintButton(HWND hwnd,Child *s,HDC dc,RECT rc) {
  /* Native Cancel remains disabled while execution owns the page; suppress
   * its inactive visual without changing its ID, style or NSIS state. */
  if(GetDlgCtrlID(hwnd)==IDCANCEL&&!IsWindowEnabled(hwnd))return;
  GpGraphics *g=graphics(dc);
  BOOL enabled=IsWindowEnabled(hwnd);UINT state=(UINT)SendMessageW(hwnd,BM_GETSTATE,0,0);
  BOOL down=(state&BST_PUSHED)!=0,focus=(state&BST_FOCUS)!=0;
  BOOL primary=GetDlgCtrlID(hwnd)==IDOK;
  if(GetDlgCtrlID(hwnd)==IDCANCEL){WCHAR action[32];cleanCaption(hwnd,action,32);HWND next=GetDlgItem(GetAncestor(hwnd,GA_ROOT),IDOK);primary=lstrcmpW(action,L"关闭")==0&&(!next||!IsWindowVisible(next));}
  BOOL close=GetDlgCtrlID(hwnd)==CLOSE_ID;
  int type=(int)(GetWindowLongPtrW(hwnd,GWL_STYLE)&BS_TYPEMASK);
  BOOL check=type==BS_CHECKBOX||type==BS_AUTOCHECKBOX||type==BS_3STATE||type==BS_AUTO3STATE||type==BS_RADIOBUTTON||type==BS_AUTORADIOBUTTON;
  BOOL hc=s->highContrast;
  COLORREF bg=surface(),fg=hc?GetSysColor(COLOR_WINDOWTEXT):TEXT;
  RECT body=rc;InflateRect(&body,-px(2,s->dpi),-px(2,s->dpi));
  if(!check&&!close&&primary){bg=hc?GetSysColor(COLOR_HIGHLIGHT):(down?RGB(24,78,185):(s->hover?RGB(30,95,223):BLUE));fg=hc?GetSysColor(COLOR_HIGHLIGHTTEXT):WHITE;}
  else if(s->hover||down)bg=hc?GetSysColor(COLOR_HIGHLIGHT):(down?RGB(232,234,239):RGB(241,243,246));
  if(hc&&(s->hover||down)&&!primary)fg=GetSysColor(COLOR_HIGHLIGHTTEXT);
  if(!enabled){bg=hc?GetSysColor(COLOR_BTNFACE):(primary?RGB(242,243,246):surface());fg=hc?GetSysColor(COLOR_GRAYTEXT):RGB(150,154,164);}
  if(!check)rounded(dc,g,body,px(11,s->dpi),bg,hc?GetSysColor(COLOR_WINDOWTEXT):CLR_INVALID,hc?px(1,s->dpi):0);
  if(close){
    int x=(rc.right+rc.left)/2,y=(rc.bottom+rc.top)/2,d=px(4,s->dpi);
    line(dc,g,x-d,y-d,x+d,y+d,imax(1,px(1,s->dpi)),fg);line(dc,g,x+d,y-d,x-d,y+d,imax(1,px(1,s->dpi)),fg);
  }else{
    WCHAR caption[512];RECT text=body;cleanCaption(hwnd,caption,512);
    HFONT font=(HFONT)SendMessageW(hwnd,WM_GETFONT,0,0);HGDIOBJ old=font?SelectObject(dc,font):0;
    SetBkMode(dc,TRANSPARENT);SetTextColor(dc,fg);
    if(check){
      int size=px(16,s->dpi),y=rc.top+(rc.bottom-rc.top-size)/2;
      RECT box={rc.left+px(3,s->dpi),y,rc.left+px(3,s->dpi)+size,y+size};
      UINT checked=(UINT)SendMessageW(hwnd,BM_GETCHECK,0,0);
      COLORREF cb=checked?(hc?GetSysColor(COLOR_HIGHLIGHT):BLUE):surface();
      COLORREF edge=checked?cb:(hc?GetSysColor(COLOR_WINDOWTEXT):RGB(175,180,189));
      if(!enabled){cb=GetSysColor(COLOR_BTNFACE);edge=GetSysColor(COLOR_GRAYTEXT);}
      BOOL radio=type==BS_RADIOBUTTON||type==BS_AUTORADIOBUTTON;
      rounded(dc,g,box,radio?size/2:px(4,s->dpi),cb,edge,imax(1,px(1,s->dpi)));
      if(checked){COLORREF mark=hc?GetSysColor(COLOR_HIGHLIGHTTEXT):WHITE;
        if(radio){RECT dot=box;InflateRect(&dot,-px(5,s->dpi),-px(5,s->dpi));rounded(dc,g,dot,size/2,mark,CLR_INVALID,0);}
        else if(checked==BST_INDETERMINATE)line(dc,g,box.left+px(4,s->dpi),y+size/2,box.right-px(4,s->dpi),y+size/2,px(2,s->dpi),mark);
        else {line(dc,g,box.left+px(4,s->dpi),y+px(8,s->dpi),box.left+px(7,s->dpi),y+px(11,s->dpi),px(2,s->dpi),mark);line(dc,g,box.left+px(7,s->dpi),y+px(11,s->dpi),box.left+px(12,s->dpi),y+px(5,s->dpi),px(2,s->dpi),mark);}}
      text.left=box.right+px(10,s->dpi);DrawTextW(dc,caption,-1,&text,DT_LEFT|DT_VCENTER|DT_SINGLELINE|DT_END_ELLIPSIS);
    }else DrawTextW(dc,caption,-1,&text,DT_CENTER|DT_VCENTER|DT_SINGLELINE|DT_END_ELLIPSIS);
    if(old)SelectObject(dc,old);
  }
  UINT ui=(UINT)SendMessageW(hwnd,WM_QUERYUISTATE,0,0);
  if(focus&&!(ui&UISF_HIDEFOCUS)){RECT ring=rc;InflateRect(&ring,-1,-1);rounded(dc,g,ring,px(12,s->dpi),CLR_INVALID,hc?GetSysColor(COLOR_WINDOWTEXT):BLUE,imax(1,px(1,s->dpi)));}
  if(g)GdipDeleteGraphics(g);
}
static void progressTimer(HWND hwnd,Child *s) {
  s->reduced=reducedMotion();s->highContrast=highContrast();
  if(s->marquee&&!s->reduced&&IsWindowVisible(hwnd))SetTimer(hwnd,ANIMATION_TIMER,16,0);
  else KillTimer(hwnd,ANIMATION_TIMER);
}
static void roundedAlpha(HDC dc,GpGraphics *g,RECT rc,int radius,COLORREF fill,BYTE alpha,COLORREF backdrop) {
  if(!alpha||rc.right<=rc.left||rc.bottom<=rc.top)return;
  if(g){
    GpPath *p=roundPath((float)rc.left,(float)rc.top,(float)(rc.right-rc.left),(float)(rc.bottom-rc.top),(float)radius);
    GpBrush *brush=0;
    if(p&&!GdipCreateSolidFill(((UINT32)alpha<<24)|(argb(fill)&0xffffffu),&brush)){GdipFillPath(g,brush,p);GdipDeleteBrush(brush);}
    if(p)GdipDeletePath(p);
  }else{
    int a=alpha;
    COLORREF blended=RGB((GetRValue(fill)*a+GetRValue(backdrop)*(255-a))/255,(GetGValue(fill)*a+GetGValue(backdrop)*(255-a))/255,(GetBValue(fill)*a+GetBValue(backdrop)*(255-a))/255);
    rounded(dc,g,rc,radius,blended,CLR_INVALID,0);
  }
}
static void paintProgress(HWND hwnd,Child *s,HDC dc,RECT rc) {
  GpGraphics *g=graphics(dc);int height=imin(px(6,s->dpi),rc.bottom-rc.top),width=rc.right-rc.left;
  RECT track={rc.left,rc.top+(rc.bottom-rc.top-height)/2,rc.right,rc.top+(rc.bottom-rc.top-height)/2+height};
  COLORREF background=s->highContrast?GetSysColor(COLOR_GRAYTEXT):s->track;
  COLORREF accent=s->highContrast?GetSysColor(COLOR_HIGHLIGHT):s->bar;
  rounded(dc,g,track,height/2,background,CLR_INVALID,0);
  int position=(int)SendMessageW(hwnd,PBM_GETPOS,0,0);
  PBRANGE range;SendMessageW(hwnd,PBM_GETRANGE,FALSE,(LPARAM)&range);
  RECT segment=track;
  if(!s->marquee&&range.iHigh>range.iLow&&position>=range.iHigh){rounded(dc,g,track,height/2,accent,CLR_INVALID,0);}
  else {
    /* Constant-size activity segment, moving left to right only. Its reset
     * occurs off-screen while transparent; this is never a task percentage. */
    int length=imin(px(100,s->dpi),imax(px(72,s->dpi),width*18/100));length=imin(length,imax(height,width*2/3));
    BYTE alpha=255;
    if(s->marquee&&!s->reduced){
      UINT elapsed=(UINT)(GetTickCount64()-s->epoch)%2000u;
      float t=elapsed/2000.0f;
      s->phase=t*t*(3.0f-2.0f*t);
      float fade=t<.14f?t/.14f:(t>.86f?(1.0f-t)/.14f:1.0f);
      alpha=(BYTE)(255.0f*fade*fade*(3.0f-2.0f*fade));
      segment.left=track.left-length+(int)((width+length)*s->phase);
    }else if(s->reduced){segment.left=track.left+(width-length)/2;}
    else{
      /* On failure retain a visible, stationary marker. Its actual color is
       * controlled by the host's original PBM_SETBARCOLOR failure message. */
      int at=-length+(int)((width+length)*s->phase);
      segment.left=track.left+imax(0,imin(width-length,at));
    }
    segment.right=segment.left+length;
    roundedAlpha(dc,g,segment,height/2,accent,alpha,background);
  }
  if(g)GdipDeleteGraphics(g);
}
static LRESULT CALLBACK ChildProc(HWND hwnd,UINT message,WPARAM wParam,LPARAM lParam,UINT_PTR id,DWORD_PTR data) {
  Child *s=(Child*)data;(void)id;
  if(message==WM_NCDESTROY){KillTimer(hwnd,ANIMATION_TIMER);RemoveWindowSubclass(hwnd,ChildProc,CHILD_SUBCLASS);RemovePropW(hwnd,CHILD_PROP);HeapFree(GetProcessHeap(),0,s);return DefSubclassProc(hwnd,message,wParam,lParam);}
  if(s->kind==2&&(message==WM_NCPAINT||message==WM_NCCALCSIZE))return 0;
  if(message==WM_ERASEBKGND)return 1;
  if(message==WM_PAINT||message==WM_PRINTCLIENT){
    PAINTSTRUCT ps;HDC target=message==WM_PAINT?BeginPaint(hwnd,&ps):(HDC)wParam;RECT rc;GetClientRect(hwnd,&rc);
    HDC dc=CreateCompatibleDC(target);HBITMAP bitmap=CreateCompatibleBitmap(target,imax(1,rc.right),imax(1,rc.bottom));HGDIOBJ old=SelectObject(dc,bitmap);
    HBRUSH brush=CreateSolidBrush(surface());FillRect(dc,&rc,brush);DeleteObject(brush);
    if(s->kind==2)paintProgress(hwnd,s,dc,rc);else paintButton(hwnd,s,dc,rc);
    BitBlt(target,0,0,rc.right,rc.bottom,dc,0,0,SRCCOPY);SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);
    if(message==WM_PAINT)EndPaint(hwnd,&ps);return 0;
  }
  if(message==WM_MOUSEMOVE&&!s->tracking){TRACKMOUSEEVENT t;t.cbSize=sizeof(t);t.dwFlags=TME_LEAVE;t.hwndTrack=hwnd;t.dwHoverTime=0;TrackMouseEvent(&t);s->tracking=TRUE;s->hover=TRUE;InvalidateRect(hwnd,0,FALSE);}
  if(message==WM_MOUSELEAVE){s->tracking=FALSE;s->hover=FALSE;InvalidateRect(hwnd,0,FALSE);}
  if(message==WM_TIMER&&wParam==ANIMATION_TIMER){InvalidateRect(hwnd,0,FALSE);return 0;}
  if(s->kind==2){
    if(message==PBM_SETMARQUEE){s->marquee=wParam!=0;if(s->marquee){s->epoch=GetTickCount64();s->phase=0;}progressTimer(hwnd,s);}
    if(message==PBM_SETBARCOLOR)s->bar=(COLORREF)lParam;
    if(message==PBM_SETBKCOLOR)s->track=(COLORREF)lParam;
    if(message==WM_SHOWWINDOW){if(wParam)progressTimer(hwnd,s);else KillTimer(hwnd,ANIMATION_TIMER);}
  }
  LRESULT value=DefSubclassProc(hwnd,message,wParam,lParam);
  if((GetDlgCtrlID(hwnd)==IDCANCEL||GetDlgCtrlID(hwnd)==IDOK)&&(message==WM_ENABLE||message==WM_SHOWWINDOW||message==WM_SETTEXT)){HWND owner=GetAncestor(hwnd,GA_ROOT);Root *r=(Root*)GetPropW(owner,SKIN_PROP);if(r&&!r->destroying)rootChrome(owner,r);}
  if(message==WM_ENABLE||message==WM_SETFOCUS||message==WM_KILLFOCUS||message==WM_LBUTTONDOWN||message==WM_LBUTTONUP||message==WM_KEYDOWN||message==WM_KEYUP||message==BM_SETSTATE||message==BM_SETCHECK||message==WM_SETTEXT||message==WM_SETFONT||message==WM_UPDATEUISTATE||message==PBM_SETPOS||message==PBM_SETMARQUEE||message==PBM_SETBARCOLOR||message==PBM_SETBKCOLOR||message==WM_THEMECHANGED||message==WM_SETTINGCHANGE)InvalidateRect(hwnd,0,FALSE);
  return value;
}
static BOOL CALLBACK refreshChild(HWND hwnd,LPARAM data) {
  Root *root=(Root*)data;WCHAR cls[64];GetClassNameW(hwnd,cls,64);
  BOOL button=lstrcmpiW(cls,L"Button")==0;
  BOOL progress=lstrcmpiW(cls,PROGRESS_CLASS)==0;
  if(!button&&!progress)return TRUE;
  if(progress&&GetDlgCtrlID(hwnd)==1004)return TRUE;
  int type=(int)(GetWindowLongPtrW(hwnd,GWL_STYLE)&BS_TYPEMASK);
  if(button&&(type==BS_GROUPBOX||type==BS_OWNERDRAW))return TRUE;
  Child *s=(Child*)GetPropW(hwnd,CHILD_PROP);
  if(!s){s=(Child*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(Child));if(!s)return TRUE;
    s->kind=progress?2:1;s->phase=.5f;s->bar=BLUE;s->track=RGB(238,240,244);s->epoch=GetTickCount64();
    if(progress)s->marquee=(GetWindowLongPtrW(hwnd,GWL_STYLE)&PBS_MARQUEE)!=0;
    if(!SetWindowSubclass(hwnd,ChildProc,CHILD_SUBCLASS,(DWORD_PTR)s)){HeapFree(GetProcessHeap(),0,s);return TRUE;}
    if(!SetPropW(hwnd,CHILD_PROP,(HANDLE)s)){RemoveWindowSubclass(hwnd,ChildProc,CHILD_SUBCLASS);HeapFree(GetProcessHeap(),0,s);return TRUE;}
    if(progress){
      /* The stock progress class may add a non-client edge even though its
       * paint is replaced. Remove both styles and NC painting, once. */
      SetWindowLongPtrW(hwnd,GWL_STYLE,GetWindowLongPtrW(hwnd,GWL_STYLE)&~(WS_BORDER|WS_DLGFRAME));
      SetWindowLongPtrW(hwnd,GWL_EXSTYLE,GetWindowLongPtrW(hwnd,GWL_EXSTYLE)&~(WS_EX_CLIENTEDGE|WS_EX_STATICEDGE|WS_EX_DLGMODALFRAME));
      SetWindowPos(hwnd,0,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED);
    }
  }
  s->dpi=root->dpi;s->reduced=reducedMotion();s->highContrast=highContrast();
  if(progress)progressTimer(hwnd,s);
  InvalidateRect(hwnd,0,FALSE);return TRUE;
}
static BOOL CALLBACK destroyChild(HWND hwnd,LPARAM data) {
  (void)data;Child *s=(Child*)GetPropW(hwnd,CHILD_PROP);
  if(s){KillTimer(hwnd,ANIMATION_TIMER);RemoveWindowSubclass(hwnd,ChildProc,CHILD_SUBCLASS);RemovePropW(hwnd,CHILD_PROP);HeapFree(GetProcessHeap(),0,s);InvalidateRect(hwnd,0,TRUE);}return TRUE;
}
static void rootChrome(HWND hwnd,Root *root) {
  RECT rc;GetClientRect(hwnd,&rc);SetWindowPos(root->close,HWND_TOP,rc.right-px(44,root->dpi),px(7,root->dpi),px(32,root->dpi),px(28,root->dpi),SWP_NOACTIVATE);
  HWND cancel=GetDlgItem(hwnd,IDCANCEL),finish=GetDlgItem(hwnd,IDOK);
  BOOL cancellable=!cancel||IsWindowEnabled(cancel);
  BOOL terminal=finish&&IsWindowVisible(finish)&&IsWindowEnabled(finish)&&(!cancel||!IsWindowVisible(cancel));
  EnableWindow(root->close,cancellable||terminal);
}
static void rootPaint(HWND hwnd,Root *root,HDC dc) {
  RECT rc;GetClientRect(hwnd,&rc);HBRUSH brush=CreateSolidBrush(surface());FillRect(dc,&rc,brush);DeleteObject(brush);
  HGDIOBJ old=SelectObject(dc,root->brandFont);SetTextColor(dc,highContrast()?GetSysColor(COLOR_WINDOWTEXT):RGB(99,105,116));SetBkMode(dc,TRANSPARENT);
  RECT label={px(22,root->dpi),px(7,root->dpi),px(130,root->dpi),px(35,root->dpi)};DrawTextW(dc,L"Relay",-1,&label,DT_LEFT|DT_VCENTER|DT_SINGLELINE);SelectObject(dc,old);
}
__declspec(dllexport) void WINAPI RelaySkinRefresh(HWND hwnd);
__declspec(dllexport) void WINAPI RelaySkinDestroy(HWND hwnd);
static LRESULT CALLBACK RootProc(HWND hwnd,UINT message,WPARAM wParam,LPARAM lParam,UINT_PTR id,DWORD_PTR data) {
  Root *root=(Root*)data;(void)id;
  if((message==WM_CTLCOLORSTATIC||message==WM_CTLCOLORDLG)&&highContrast()){HDC dc=(HDC)wParam;SetBkColor(dc,GetSysColor(COLOR_WINDOW));SetTextColor(dc,GetSysColor(COLOR_WINDOWTEXT));return (LRESULT)GetSysColorBrush(COLOR_WINDOW);}
  if(message==WM_SYSCOMMAND&&((wParam&0xfff0)==SC_SIZE||(wParam&0xfff0)==SC_MAXIMIZE))return 0;
  if(message==WM_NCCALCSIZE)return 0;
  if(message==WM_NCHITTEST){POINT p={GET_X_LPARAM(lParam),GET_Y_LPARAM(lParam)};ScreenToClient(hwnd,&p);RECT rc;GetClientRect(hwnd,&rc);if(p.y>=0&&p.y<px(36,root->dpi)&&p.x<rc.right-px(48,root->dpi))return HTCAPTION;return HTCLIENT;}
  if(message==WM_NCPAINT)return 0;
  if(message==WM_ERASEBKGND)return 1;
  if(message==WM_PAINT){PAINTSTRUCT ps;HDC dc=BeginPaint(hwnd,&ps);rootPaint(hwnd,root,dc);EndPaint(hwnd,&ps);return 0;}
  /* Leave the custom Button click/capture stack before activating the native
   * Finish button. A nested synchronous BM_CLICK can be lost by BUTTON. */
  if(message==WM_COMMAND&&LOWORD(wParam)==CLOSE_ID){if(HIWORD(wParam)==BN_CLICKED){HWND cancel=GetDlgItem(hwnd,IDCANCEL),finish=GetDlgItem(hwnd,IDOK);if(!cancel||IsWindowEnabled(cancel))PostMessageW(hwnd,WM_CLOSE,0,0);else if(finish&&IsWindowVisible(finish)&&IsWindowEnabled(finish)&&!IsWindowVisible(cancel))PostMessageW(finish,BM_CLICK,0,0);}return 0;}
  if(message==WM_NCDESTROY){RelaySkinDestroy(hwnd);return DefSubclassProc(hwnd,message,wParam,lParam);}
  LRESULT value=DefSubclassProc(hwnd,message,wParam,lParam);
  if(message==WM_SIZE||message==WM_ENABLE)rootChrome(hwnd,root);
  if(message==WM_SETTINGCHANGE||message==WM_THEMECHANGED)RelaySkinRefresh(hwnd);
  return value;
}
__declspec(dllexport) int WINAPI RelaySkinAttach(HWND hwnd,int dpi) {
  if(!IsWindow(hwnd))return 0;
  Root *previous=(Root*)GetPropW(hwnd,SKIN_PROP);if(previous){RelaySkinRefresh(hwnd);return 1;}
  Root *root=(Root*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,sizeof(Root));if(!root)return 0;
  root->dpi=dpi>=72&&dpi<=768?dpi:96;root->style=GetWindowLongPtrW(hwnd,GWL_STYLE);
  root->brandFont=CreateFontW(-px(12,root->dpi),0,0,0,FW_MEDIUM,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
  if(!SetWindowSubclass(hwnd,RootProc,ROOT_SUBCLASS,(DWORD_PTR)root)){if(root->brandFont)DeleteObject(root->brandFont);HeapFree(GetProcessHeap(),0,root);return 0;}
  if(!SetPropW(hwnd,SKIN_PROP,(HANDLE)root)){RemoveWindowSubclass(hwnd,RootProc,ROOT_SUBCLASS);if(root->brandFont)DeleteObject(root->brandFont);HeapFree(GetProcessHeap(),0,root);return 0;}
  if(!gdiplusToken){GdiStartup input;input.version=1;input.debug=0;input.suppressThread=FALSE;input.suppressCodecs=FALSE;GdiplusStartup(&gdiplusToken,&input,0);}
  InterlockedIncrement(&rootCount);
  /* Pin the small module until process exit. Late native messages can never
   * dispatch into unloaded code, even if a host forgets the Destroy contract. */
  HMODULE self=0;GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,(LPCWSTR)&RelaySkinAttach,&self);
  root->close=CreateWindowExW(0,L"Button",L"关闭",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON,0,0,0,0,hwnd,(HMENU)CLOSE_ID,GetModuleHandleW(0),0);
  if(!root->close){RelaySkinDestroy(hwnd);return 0;}
  SendMessageW(root->close,WM_SETFONT,(WPARAM)root->brandFont,FALSE);
  RECT before,client;GetWindowRect(hwnd,&before);GetClientRect(hwnd,&client);
  SetWindowLongPtrW(hwnd,GWL_STYLE,(root->style&~(WS_CAPTION|WS_MAXIMIZEBOX))|WS_THICKFRAME|WS_CLIPCHILDREN);root->frameless=TRUE;
  int width=client.right-client.left,height=client.bottom-client.top;
  SetWindowPos(hwnd,0,before.left+((before.right-before.left)-width)/2,before.top+((before.bottom-before.top)-height)/2,width,height,SWP_FRAMECHANGED|SWP_NOACTIVATE|SWP_NOZORDER);
  int corner=2,nc=2;MARGINS margins={1,1,1,1};
  DwmSetWindowAttribute(hwnd,DWMWA_WINDOW_CORNER_PREFERENCE,&corner,sizeof(corner));DwmSetWindowAttribute(hwnd,DWMWA_NCRENDERING_POLICY,&nc,sizeof(nc));DwmExtendFrameIntoClientArea(hwnd,&margins);
  RelaySkinRefresh(hwnd);RedrawWindow(hwnd,0,0,RDW_INVALIDATE|RDW_ALLCHILDREN);return 1;
}
__declspec(dllexport) void WINAPI RelaySkinRefresh(HWND hwnd) {
  Root *root=(Root*)GetPropW(hwnd,SKIN_PROP);if(!root||root->destroying)return;
  rootChrome(hwnd,root);EnumChildWindows(hwnd,refreshChild,(LPARAM)root);InvalidateRect(hwnd,0,FALSE);
}
__declspec(dllexport) void WINAPI RelaySkinDestroy(HWND hwnd) {
  Root *root=(Root*)GetPropW(hwnd,SKIN_PROP);if(!root||root->destroying)return;root->destroying=TRUE;
  /* GUIEnd occurs before native destruction on NSIS. Hide first so restoring
   * system styles cannot flash the original installer caption on exit. */
  if(root->frameless&&IsWindowVisible(hwnd))ShowWindow(hwnd,SW_HIDE);
  EnumChildWindows(hwnd,destroyChild,0);if(root->close&&IsWindow(root->close))DestroyWindow(root->close);
  RemoveWindowSubclass(hwnd,RootProc,ROOT_SUBCLASS);RemovePropW(hwnd,SKIN_PROP);
  if(IsWindow(hwnd)){SetWindowLongPtrW(hwnd,GWL_STYLE,root->style);SetWindowPos(hwnd,0,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED);}
  if(root->brandFont)DeleteObject(root->brandFont);HeapFree(GetProcessHeap(),0,root);
  if(InterlockedDecrement(&rootCount)==0&&gdiplusToken){GdiplusShutdown(gdiplusToken);gdiplusToken=0;}
}
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID reserved) {(void)module;(void)reason;(void)reserved;return TRUE;}
