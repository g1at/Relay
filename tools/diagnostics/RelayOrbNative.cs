// Read-only native telemetry. Does not activate, move, resize, capture, or message windows.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace RelayOrbDiagnostics {
    public static class Native {
        private delegate bool WindowCallback(IntPtr window, IntPtr data);
        private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data);
        [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left, top, right, bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct Point { public int x, y; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct MonitorInfo {
            public int size; public Rect monitor, work; public uint flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string device;
        }
        [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref Point point);
        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
        [DllImport("user32.dll")] private static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLong64(IntPtr window, int index);
        [DllImport("user32.dll")] private static extern bool GetLayeredWindowAttributes(IntPtr window, out uint color, out byte alpha, out uint flags);
        [DllImport("user32.dll")] private static extern int GetWindowRgn(IntPtr window, IntPtr region);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll")] private static extern int GetRgnBox(IntPtr region, out Rect rect);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmRect(IntPtr window, int attribute, out Rect rect, int size);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmInt(IntPtr window, int attribute, out int value, int size);
        [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);

        private static Dictionary<string, object> Box(Rect rect) {
            return new Dictionary<string, object> { { "left", rect.left }, { "top", rect.top },
                { "right", rect.right }, { "bottom", rect.bottom }, { "width", rect.right - rect.left }, { "height", rect.bottom - rect.top } };
        }
        private static string Handle(IntPtr value) { return "0x" + value.ToInt64().ToString("X"); }
        private static IntPtr EnterPhysicalCoordinates() { return SetThreadDpiAwarenessContext(new IntPtr(-4)); }
        private static void RestoreDpi(IntPtr previous) { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
        private static long Style(IntPtr window, int index) {
            return IntPtr.Size == 8 ? GetWindowLong64(window, index).ToInt64() : (uint)GetWindowLong32(window, index);
        }
        private static Dictionary<string, object> Region(IntPtr window) {
            IntPtr region = CreateRectRgn(0, 0, 0, 0);
            if (region == IntPtr.Zero) return new Dictionary<string, object> { { "error", "allocation_failed" } };
            try {
                int type = GetWindowRgn(window, region);
                string[] names = { "no_explicit_region_or_error", "empty", "simple", "complex" };
                var result = new Dictionary<string, object> { { "type", type },
                    { "typeName", type >= 0 && type < names.Length ? names[type] : "unknown" },
                    { "coordinateSpace", "physical pixels relative to window upper-left" } };
                // Zero usually means no explicit region. It is NOT proof of an empty/clipped window.
                if (type > 0) { Rect box; int boxType = GetRgnBox(region, out box); result["boxType"] = boxType; if (boxType > 0) result["box"] = Box(box); }
                return result;
            } finally { DeleteObject(region); }
        }
        public static Dictionary<string, object>[] Monitors() {
            var results = new List<Dictionary<string, object>>();
            IntPtr previous = EnterPhysicalCoordinates();
            try {
                EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data) {
                    var info = new MonitorInfo(); info.size = Marshal.SizeOf(typeof(MonitorInfo));
                    if (!GetMonitorInfo(monitor, ref info)) return true;
                    uint x, y; int dpiResult = GetDpiForMonitor(monitor, 0, out x, out y);
                    results.Add(new Dictionary<string, object> { { "handle", Handle(monitor) }, { "device", info.device },
                        { "primary", (info.flags & 1) != 0 }, { "bounds", Box(info.monitor) }, { "workArea", Box(info.work) },
                        { "effectiveDpiResult", dpiResult }, { "effectiveDpiX", x }, { "effectiveDpiY", y },
                        { "scalePercent", dpiResult == 0 ? (object)Math.Round(x * 100.0 / 96, 2) : null },
                        { "physicalCoordinatesRequested", previous != IntPtr.Zero } });
                    return true;
                }, IntPtr.Zero);
            } finally { RestoreDpi(previous); }
            return results.ToArray();
        }
        public static Dictionary<string, object>[] Windows() {
            var results = new List<Dictionary<string, object>>();
            IntPtr previous = EnterPhysicalCoordinates();
            try {
                EnumWindows(delegate(IntPtr window, IntPtr data) {
                    // Titles are compared in memory only. No other application's title is retained.
                    var title = new StringBuilder(128);
                    GetWindowText(window, title, title.Capacity);
                    if (!String.Equals(title.ToString(), "Relay \u60ac\u6d6e\u7403", StringComparison.Ordinal)) return true;
                    uint id; GetWindowThreadProcessId(window, out id);
                    try {
                        using (Process process = Process.GetProcessById((int)id)) {
                            string name = process.ProcessName;
                            if (!String.Equals(name, "Relay", StringComparison.OrdinalIgnoreCase) && !String.Equals(name, "electron", StringComparison.OrdinalIgnoreCase)) return true;
                            var result = new Dictionary<string, object> { { "handle", Handle(window) }, { "processId", id },
                                { "processName", name }, { "physicalCoordinatesRequested", previous != IntPtr.Zero } };
                            try { result["processStartedUtc"] = process.StartTime.ToUniversalTime().ToString("o"); result["workingSetBytes"] = process.WorkingSet64; result["cpuTotalMs"] = process.TotalProcessorTime.TotalMilliseconds; }
                            catch (Exception e) { result["processMetricsErrorType"] = e.GetType().Name; }
                            Rect outer, client, frame;
                            bool outerOk = GetWindowRect(window, out outer), clientOk = GetClientRect(window, out client);
                            result["windowRectOk"] = outerOk; result["clientRectOk"] = clientOk;
                            if (outerOk) result["windowRect"] = Box(outer);
                            if (clientOk) result["clientRect"] = Box(client);
                            var origin = new Point(); if (ClientToScreen(window, ref origin)) result["clientScreenOrigin"] = new Dictionary<string, object> { { "x", origin.x }, { "y", origin.y } };
                            uint dpi = GetDpiForWindow(window); result["dpi"] = dpi; result["scalePercent"] = Math.Round(dpi * 100.0 / 96, 2);
                            result["dpiAwareness"] = GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(window));
                            result["monitor"] = Handle(MonitorFromWindow(window, 2));
                            result["visible"] = IsWindowVisible(window); result["minimized"] = IsIconic(window);
                            result["styleHex"] = Style(window, -16).ToString("X"); result["extendedStyleHex"] = Style(window, -20).ToString("X");
                            result["windowRegion"] = Region(window);
                            int frameResult = DwmRect(window, 9, out frame, Marshal.SizeOf(typeof(Rect)));
                            result["dwmFrameResult"] = frameResult; if (frameResult == 0) result["dwmFrameBounds"] = Box(frame);
                            int cloaked; int cloakResult = DwmInt(window, 14, out cloaked, sizeof(int));
                            result["dwmCloakedResult"] = cloakResult; if (cloakResult == 0) result["dwmCloaked"] = cloaked;
                            uint color, flags; byte alpha;
                            bool layeredOk = GetLayeredWindowAttributes(window, out color, out alpha, out flags);
                            result["layeredAttributesAvailable"] = layeredOk;
                            if (layeredOk) { result["layeredAlpha"] = alpha; result["layeredFlags"] = flags; }
                            results.Add(result);
                        }
                    } catch (Exception e) {
                        // A process/window may close between enumeration and measurement.
                        results.Add(new Dictionary<string, object> { { "handle", Handle(window) }, { "processId", id }, { "measurementErrorType", e.GetType().Name } });
                    }
                    return results.Count < 32;
                }, IntPtr.Zero);
            } finally { RestoreDpi(previous); }
            return results.ToArray();
        }
    }
}
