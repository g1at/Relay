#include "sdk-job-state.h"
#include <string>
#include <vector>

static std::wstring Quote(const std::wstring& value) {
  // Match Node/libuv's non-verbatim argument encoding. Unnecessary quotes are
  // observable by cmd.exe and batch files (%0/%~dp0); quoting every argument
  // changes an explicit `cmd /c npx ...` launch even though CRT argv roundtrips.
  if (!value.empty() && value.find_first_of(L" \t\"") == std::wstring::npos) return value;
  std::wstring out = L"\""; size_t slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') { ++slashes; continue; }
    out.append(slashes * (c == L'"' ? 2 : 1), L'\\'); slashes = 0;
    if (c == L'"') out.push_back(L'\\');
    out.push_back(c);
  }
  out.append(slashes * 2, L'\\'); out.push_back(L'"'); return out;
}
int wmain(int argc, wchar_t** argv) {
  if (argc < 3) return 125;
  const std::wstring name = argv[1], mappingName = name + L"-state";
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mappingName.c_str());
  if (!mapping) return 125;
  auto state = static_cast<RelayJobState*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(RelayJobState)));
  if (!state) { CloseHandle(mapping); return 125; }
  HANDLE job = OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_QUERY, FALSE, name.c_str());
  auto fail = [&](DWORD error) {
    InterlockedExchange(&state->spawnError, static_cast<LONG>(error));
    InterlockedExchange(&state->spawnState, 3);
    if (job) CloseHandle(job);
    UnmapViewOfFile(state); CloseHandle(mapping); return 125;
  };
  if (!job) return fail(GetLastError());
  if (InterlockedCompareExchange(&state->canceled, 0, 0)) return fail(ERROR_CANCELLED);
  const bool verbatim = std::wstring(argv[2]) == L"--relay-verbatim";
  const int commandIndex = verbatim ? 3 : 2;
  if (argc <= commandIndex) return fail(ERROR_INVALID_PARAMETER);
  std::wstring commandLine = Quote(argv[commandIndex]);
  for (int i = commandIndex + 1; i < argc; ++i) {
    commandLine += L" "; commandLine += verbatim ? argv[i] : Quote(argv[i]);
  }
  std::vector<wchar_t> mutableLine(commandLine.begin(), commandLine.end()); mutableLine.push_back(0);
  STARTUPINFOW startup = {}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process = {};
  // No code runs before membership is established. Descendants inherit this Job,
  // including detached shells, and the Job does not permit breakaway.
  if (!CreateProcessW(nullptr, mutableLine.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process))
    return fail(GetLastError());
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    DWORD error = GetLastError(); TerminateProcess(process.hProcess, 125);
    WaitForSingleObject(process.hProcess, INFINITE);
    CloseHandle(process.hThread); CloseHandle(process.hProcess); return fail(error);
  }
  InterlockedExchange(&state->sdkPid, static_cast<LONG>(process.dwProcessId));
  InterlockedExchange(&state->spawnState, 1);
  // Relay retains the only Job handle after this point. Closing Relay (even a
  // crash) therefore closes the Job and terminates all owned processes.
  CloseHandle(job); job = nullptr;
  if (InterlockedCompareExchange(&state->canceled, 0, 0)) TerminateProcess(process.hProcess, 130);
  else if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    InterlockedExchange(&state->spawnError, static_cast<LONG>(GetLastError()));
    TerminateProcess(process.hProcess, 125);
  } else InterlockedExchange(&state->spawnState, 2);
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = 125; GetExitCodeProcess(process.hProcess, &exitCode);
  CloseHandle(process.hProcess); UnmapViewOfFile(state); CloseHandle(mapping);
  return static_cast<int>(exitCode);
}
