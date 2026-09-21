// Minimal Node-API bridge for Windows taskbar overlays.
// Electron 32 reduces every setOverlayIcon image to 16 physical pixels. This
// bridge gives Explorer the independently drawn frame for the window's DPI.
// Only stable Node-API C ABI declarations used here are declared below; exports
// are resolved from the host, so no Node/Electron headers or import lib are needed.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shobjidl.h>
#include <stdint.h>
#include <stddef.h>
#include <string>
#include <vector>

struct napi_env__; struct napi_value__; struct napi_callback_info__;
using napi_env = napi_env__*;
using napi_value = napi_value__*;
using napi_callback_info = napi_callback_info__*;
using napi_callback = napi_value (__cdecl *)(napi_env, napi_callback_info);
using napi_status = int;
#define NAPI_FUNCTIONS(X) \
 X(napi_get_cb_info, (napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**)) \
 X(napi_get_buffer_info, (napi_env, napi_value, void**, size_t*)) \
 X(napi_get_value_string_utf16, (napi_env, napi_value, char16_t*, size_t, size_t*)) \
 X(napi_create_uint32, (napi_env, uint32_t, napi_value*)) \
 X(napi_create_function, (napi_env, const char*, size_t, napi_callback, void*, napi_value*)) \
 X(napi_set_named_property, (napi_env, napi_value, const char*, napi_value)) \
 X(napi_throw_error, (napi_env, const char*, const char*))
#define DECLARE_API(name, arguments) static napi_status (__cdecl *name) arguments;
NAPI_FUNCTIONS(DECLARE_API)
#undef DECLARE_API

static napi_value Fail(napi_env env, const char* text) {
  napi_throw_error(env, "ERR_TASKBAR_OVERLAY", text);
  return nullptr;
}
static bool WindowArgument(napi_env env, napi_value value, HWND* result) {
  void* bytes = nullptr; size_t length = 0;
  if (napi_get_buffer_info(env, value, &bytes, &length) != 0 ||
      length != sizeof(HWND)) return false;
  memcpy(result, bytes, sizeof(HWND));
  DWORD owner = 0;
  return IsWindow(*result) && GetWindowThreadProcessId(*result, &owner) &&
         owner == GetCurrentProcessId();
}
static napi_value OverlaySize(napi_env env, napi_callback_info info) {
  napi_value args[1]; size_t argc = 1; HWND window = nullptr;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != 0 ||
      argc != 1 || !WindowArgument(env, args[0], &window))
    return Fail(env, "Overlay window must belong to this process");
  auto getDpi = reinterpret_cast<UINT (WINAPI *)(HWND)>(
      GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
  UINT dpi = getDpi ? getDpi(window) : 96;
  if (!dpi) dpi = 96;
  napi_value result;
  napi_create_uint32(env, static_cast<uint32_t>(MulDiv(16, dpi, 96)), &result);
  return result;
}
static napi_value SetOverlay(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t argc = 3; HWND window = nullptr;
  void* bytes = nullptr; size_t length = 0; size_t textLength = 0;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != 0 ||
      argc != 3 || !WindowArgument(env, args[0], &window))
    return Fail(env, "Overlay window must belong to this process");
  if (napi_get_buffer_info(env, args[1], &bytes, &length) != 0 ||
      length > 1024 * 1024 ||
      napi_get_value_string_utf16(env, args[2], nullptr, 0, &textLength) != 0 ||
      textLength > 1024) return Fail(env, "Invalid overlay image or description");
  std::vector<char16_t> description(textLength + 1);
  if (napi_get_value_string_utf16(env, args[2], description.data(),
                                description.size(), &textLength) != 0)
    return Fail(env, "Invalid overlay description");
  HICON icon = nullptr;
  if (length) {
    const unsigned char* png = static_cast<unsigned char*>(bytes);
    const unsigned char signature[] = {137, 80, 78, 71, 13, 10, 26, 10};
    if (length < 24 || memcmp(png, signature, 8) != 0 ||
        png[16] || png[17] || png[18] || png[20] || png[21] || png[22] ||
        png[19] < 16 || png[19] > 128 || png[19] != png[23])
      return Fail(env, "Overlay must be a square 16-128px PNG");
    icon = CreateIconFromResourceEx(static_cast<PBYTE>(bytes),
        static_cast<DWORD>(length), TRUE, 0x00030000, png[19], png[23], LR_DEFAULTCOLOR);
    if (!icon) return Fail(env, "Windows could not decode the overlay PNG");
  }
  // Electron already initializes COM on its main thread. Balance only an
  // initialization done here, including S_FALSE, and tolerate another apartment.
  HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  ITaskbarList3* taskbar = nullptr;
  HRESULT result = CoCreateInstance(CLSID_TaskbarList, nullptr,
      CLSCTX_INPROC_SERVER, IID_ITaskbarList3, reinterpret_cast<void**>(&taskbar));
  if (SUCCEEDED(result)) result = taskbar->HrInit();
  if (SUCCEEDED(result)) result = taskbar->SetOverlayIcon(
      window, icon, reinterpret_cast<LPCWSTR>(description.data()));
  // Report the actual HICON bitmap width, not the PNG header or requested size.
  uint32_t width = 0;
  if (icon) {
    ICONINFO info = {};
    if (GetIconInfo(icon, &info)) {
      BITMAP bitmap = {};
      if (GetObjectW(info.hbmColor, sizeof(bitmap), &bitmap)) width = bitmap.bmWidth;
      if (info.hbmColor) DeleteObject(info.hbmColor);
      if (info.hbmMask) DeleteObject(info.hbmMask);
    }
    DestroyIcon(icon);
  }
  if (taskbar) taskbar->Release();
  if (SUCCEEDED(initialized)) CoUninitialize();
  if (FAILED(result)) return Fail(env, "Windows rejected the taskbar overlay");
  napi_value value;
  napi_create_uint32(env, width, &value);
  return value;
}
extern "C" __declspec(dllexport) napi_value __cdecl
napi_register_module_v1(napi_env env, napi_value exports) {
  HMODULE host = GetModuleHandleW(nullptr);
#define LOAD_API(name, arguments) \
  name = reinterpret_cast<decltype(name)>(GetProcAddress(host, #name)); \
  if (!name) return nullptr;
  NAPI_FUNCTIONS(LOAD_API)
#undef LOAD_API
  napi_value getSize, setOverlay;
  napi_create_function(env, "getOverlaySize", SIZE_MAX, OverlaySize, nullptr, &getSize);
  napi_create_function(env, "setOverlayIcon", SIZE_MAX, SetOverlay, nullptr, &setOverlay);
  napi_set_named_property(env, exports, "getOverlaySize", getSize);
  napi_set_named_property(env, exports, "setOverlayIcon", setOverlay);
  return exports;
}
