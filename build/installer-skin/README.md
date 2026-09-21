# Relay 安装界面皮肤

`relay-installer-skin.dll` 是供 NSIS 安装器和卸载器加载的 x86 原生绘制模块。发布时直接使用已编译 DLL；不需要用户额外安装运行库、浏览器或编译器。依赖仅为 Windows 自带的 Kernel32、User32、GDI32、Comctl32、DWMAPI 和 GDI+。

皮肤负责无边框窗口、系统圆角/阴影、拖动区域、按钮、复选框与活动进度条。NSIS 继续负责原始控件状态、键盘操作、取消、安装流程与退出码；不会用计时器生成安装百分比。活动条以固定长度单向滑过 6dp 轨道，首尾渐隐而不回弹；不表示完成百分比，仅收到真实成功状态后才填满。系统减少动画时使用静态标记。

## 主机接口

三个导出均为 x86 `WINAPI` / `stdcall`，导出名称不带装饰：

- `int RelaySkinAttach(HWND, int dpi)`：在主机完成客户区布局后调用；成功返回 1，失败返回 0。保持现有客户区尺寸，不负责页面文案布局。
- `void RelaySkinRefresh(HWND)`：每次页面切换或终态变更后调用，识别并装饰新增原生控件。原始进度源 ID 1004 始终不处理。
- `void RelaySkinDestroy(HWND)`：在 GUI 退出时调用，移除子类、定时器及 GDI 资源。成功装饰过的窗口先隐藏，再恢复系统样式，避免退出前原生标题栏闪回。

主机只在可见 GUI 模式提取/加载皮肤。加载失败保留原生界面，不中断安装。模块成功附着后固定保留到进程退出，避免迟到的窗口消息跳入已卸载 DLL。额外关闭按钮 ID 为 6201，工作中遵循原取消按钮启用状态；完成页遵循原完成按钮行为。

## 离线重新构建

在 Windows 仓库中运行：

```powershell
npm run build:installer-skin
```

需要本机已有 LLVM 的 `clang.exe`、`llvm-dlltool.exe`、`ld.lld.exe`、`llvm-readobj.exe` 及 MinGW Windows 头文件。默认使用用户 Scoop 的 `llvm/current/bin` 与 `mingw/current/x86_64-w64-mingw32/include`；其他安装位置通过 `RELAY_LLVM_BIN` 和 `RELAY_MINGW_HEADERS` 指定。头文件可用于 i686 目标，不链接 x64 库，也不依赖 32 位 CRT。

脚本自动创建最小系统导入库、编译、核对 PE 架构/导出/依赖，并更新 `manifest.json` 的源码、构建脚本和 DLL 哈希。下游打包只校验预编译资源，无需重新编译。
