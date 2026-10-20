#include "sdk-job-state.h"
#include <stdint.h>
#include <stddef.h>
#include <string>
#include <vector>
struct napi_env__; struct napi_value__; struct napi_callback_info__;
using napi_env = napi_env__*; using napi_value = napi_value__*; using napi_callback_info = napi_callback_info__*;
using napi_callback = napi_value (__cdecl *)(napi_env, napi_callback_info);
using napi_finalize = void (__cdecl *)(napi_env, void*, void*); using napi_status = int;
#define NAPI_FUNCTIONS(X) \
 X(napi_get_cb_info, (napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**)) \
 X(napi_get_value_string_utf16, (napi_env, napi_value, char16_t*, size_t, size_t*)) \
 X(napi_create_uint32, (napi_env, uint32_t, napi_value*)) \
 X(napi_get_boolean, (napi_env, bool, napi_value*)) \
 X(napi_create_object, (napi_env, napi_value*)) \
 X(napi_create_external, (napi_env, void*, napi_finalize, void*, napi_value*)) \
 X(napi_get_value_external, (napi_env, napi_value, void**)) \
 X(napi_create_function, (napi_env, const char*, size_t, napi_callback, void*, napi_value*)) \
 X(napi_set_named_property, (napi_env, napi_value, const char*, napi_value)) \
 X(napi_throw_error, (napi_env, const char*, const char*))
#define DECLARE_API(name, arguments) static napi_status (__cdecl *name) arguments;
NAPI_FUNCTIONS(DECLARE_API)
#undef DECLARE_API
struct ProcessHandle { DWORD pid; HANDLE handle; };
struct Scope { HANDLE job = nullptr; HANDLE mapping = nullptr; RelayJobState* state = nullptr; bool closed = false; std::vector<ProcessHandle> processes; };
static void Close(Scope* scope) {
  if (scope->closed) return;
  scope->closed = true;
  for (const auto& process : scope->processes) CloseHandle(process.handle);
  scope->processes.clear();
  if (scope->state) UnmapViewOfFile(scope->state);
  if (scope->mapping) CloseHandle(scope->mapping);
  if (scope->job) CloseHandle(scope->job); // KILL_ON_JOB_CLOSE is the crash/GC safety net.
  scope->state = nullptr; scope->job = nullptr; scope->mapping = nullptr;
}
static void Finalize(napi_env, void* data, void*) { auto scope = static_cast<Scope*>(data); Close(scope); delete scope; }
static napi_value Fail(napi_env env, const char* text) {
  std::string message = std::string(text) + " (Windows error " + std::to_string(GetLastError()) + ")";
  napi_throw_error(env, "ERR_SDK_PROCESS_TREE", message.c_str()); return nullptr;
}
static Scope* Argument(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1; void* data = nullptr;
  if (napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr) || count != 1 ||
      napi_get_value_external(env, arg, &data) || !data) return nullptr;
  return static_cast<Scope*>(data);
}
static napi_value Create(napi_env env, napi_callback_info info) {
  napi_value arg; size_t count = 1, length = 0;
  if (napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr) || count != 1 ||
      napi_get_value_string_utf16(env, arg, nullptr, 0, &length) || !length || length > 200)
    return Fail(env, "Invalid private Job name");
  std::vector<char16_t> name(length + 1);
  napi_get_value_string_utf16(env, arg, name.data(), name.size(), &length);
  const auto jobName = reinterpret_cast<LPCWSTR>(name.data());
  Scope* scope = new Scope();
  scope->job = CreateJobObjectW(nullptr, jobName);
  if (!scope->job || GetLastError() == ERROR_ALREADY_EXISTS) {
    Close(scope); delete scope; return Fail(env, "Cannot create exclusive SDK Job");
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(scope->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    Close(scope); delete scope; return Fail(env, "Cannot protect SDK Job");
  }
  std::wstring mappingName = std::wstring(jobName) + L"-state";
  scope->mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(RelayJobState), mappingName.c_str());
  if (!scope->mapping || GetLastError() == ERROR_ALREADY_EXISTS) {
    Close(scope); delete scope; return Fail(env, "Cannot create SDK Job state");
  }
  scope->state = static_cast<RelayJobState*>(MapViewOfFile(scope->mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(RelayJobState)));
  if (!scope->state) { Close(scope); delete scope; return Fail(env, "Cannot map SDK Job state"); }
  ZeroMemory(scope->state, sizeof(RelayJobState));
  napi_value result;
  napi_create_external(env, scope, Finalize, nullptr, &result); return result;
}
static bool CaptureProcesses(Scope* scope) {
  size_t capacity = 64;
  std::vector<unsigned char> bytes;
  for (;;) {
    bytes.resize(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + capacity * sizeof(ULONG_PTR));
    auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
    if (QueryInformationJobObject(scope->job, JobObjectBasicProcessIdList, list, static_cast<DWORD>(bytes.size()), nullptr)) {
      for (DWORD index = 0; index < list->NumberOfProcessIdsInList; ++index) {
        DWORD pid = static_cast<DWORD>(list->ProcessIdList[index]); bool held = false;
        for (const auto& process : scope->processes) {
          if (process.pid != pid) continue;
          DWORD waited = WaitForSingleObject(process.handle, 0);
          if (waited == WAIT_FAILED) return false;
          // A terminated object's handle must not suppress capture when Windows
          // reuses its numeric PID for a newer member of this same Job.
          if (waited != WAIT_OBJECT_0) { held = true; break; }
        }
        if (held) continue;
        HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!process) { if (GetLastError() == ERROR_INVALID_PARAMETER) continue; return false; }
        BOOL belongs = FALSE;
        if (!IsProcessInJob(process, scope->job, &belongs)) { CloseHandle(process); return false; }
        // The PID may have exited/reused between enumeration and OpenProcess.
        // Membership on the retained kernel handle, never its PID, authorizes it.
        if (!belongs) { CloseHandle(process); continue; }
        scope->processes.push_back({pid, process});
      }
      return true;
    }
    if (GetLastError() != ERROR_MORE_DATA || capacity > 1048576) return false;
    capacity *= 2;
  }
}
static napi_value Snapshot(napi_env env, napi_callback_info info) {
  Scope* scope = Argument(env, info);
  if (!scope || scope->closed) return Fail(env, "SDK Job handle is closed");
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
  if (!QueryInformationJobObject(scope->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr))
    return Fail(env, "Cannot confirm SDK Job exit");
  napi_value result; napi_create_object(env, &result);
  auto field = [&](const char* name, uint32_t value) { napi_value item; napi_create_uint32(env, value, &item); napi_set_named_property(env, result, name, item); };
  DWORD pendingExits = 0;
  for (const auto& process : scope->processes) {
    DWORD waited = WaitForSingleObject(process.handle, 0);
    if (waited == WAIT_FAILED) return Fail(env, "Cannot confirm SDK member exit");
    if (waited != WAIT_OBJECT_0) ++pendingExits;
  }
  field("activeProcesses", accounting.ActiveProcesses);
  field("pendingExits", pendingExits);
  field("sdkPid", InterlockedCompareExchange(&scope->state->sdkPid, 0, 0));
  field("spawnState", InterlockedCompareExchange(&scope->state->spawnState, 0, 0));
  field("spawnError", InterlockedCompareExchange(&scope->state->spawnError, 0, 0));
  return result;
}
static napi_value Terminate(napi_env env, napi_callback_info info) {
  Scope* scope = Argument(env, info);
  if (!scope || scope->closed) return Fail(env, "SDK Job handle is closed");
  InterlockedExchange(&scope->state->canceled, 1);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  if (!QueryInformationJobObject(scope->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr))
    return Fail(env, "Cannot inspect stopping SDK Job limits");
  // Seal new descendants before taking member handles. Any live parent already
  // counts as one process, so admitting its child would exceed this limit.
  // Existing members are retained by Windows; this limit applies to admission.
  limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  if (!SetInformationJobObject(scope->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return Fail(env, "Cannot seal stopping SDK Job");
  if (!CaptureProcesses(scope)) return Fail(env, "Cannot retain SDK member handles");
  if (!TerminateJobObject(scope->job, 130)) return Fail(env, "Cannot terminate SDK Job");
  if (!CaptureProcesses(scope)) return Fail(env, "Cannot retain terminating SDK member handles");
  napi_value result; napi_get_boolean(env, true, &result); return result;
}
static napi_value Dispose(napi_env env, napi_callback_info info) {
  Scope* scope = Argument(env, info); if (!scope) return Fail(env, "Invalid SDK Job handle");
  Close(scope); napi_value result; napi_get_boolean(env, true, &result); return result;
}
extern "C" __declspec(dllexport) napi_value __cdecl napi_register_module_v1(napi_env env, napi_value exports) {
  HMODULE host = GetModuleHandleW(nullptr);
#define LOAD_API(name, arguments) name = reinterpret_cast<decltype(name)>(GetProcAddress(host, #name)); if (!name) return nullptr;
  NAPI_FUNCTIONS(LOAD_API)
#undef LOAD_API
  struct { const char* name; napi_callback call; } methods[] = {
    {"create", Create}, {"snapshot", Snapshot}, {"terminate", Terminate}, {"close", Dispose}
  };
  for (const auto& method : methods) {
    napi_value fn; napi_create_function(env, method.name, SIZE_MAX, method.call, nullptr, &fn);
    napi_set_named_property(env, exports, method.name, fn);
  }
  return exports;
}
