'use strict';
// Offline x86 DLL build. Only a Windows clang/LLVM toolchain and the existing
// MinGW Windows headers are needed; no 32-bit CRT, SDK download or npm module.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
if (process.platform !== 'win32') throw new Error('Run with Windows Node.js (the skin targets the x86 Windows NSIS host).');
const root = path.resolve(__dirname, '..');
const directory = path.join(__dirname, 'installer-skin');
const staging = path.join(root, '.codex-tmp', 'installer-skin-build');
fs.mkdirSync(staging, { recursive: true });
const llvm = process.env.RELAY_LLVM_BIN || path.join(os.homedir(), 'scoop/apps/llvm/current/bin');
const headers = process.env.RELAY_MINGW_HEADERS || path.join(os.homedir(), 'scoop/apps/mingw/current/x86_64-w64-mingw32/include');
const clang = path.join(llvm, 'clang.exe');
const dlltool = path.join(llvm, 'llvm-dlltool.exe');
const linker = path.join(llvm, 'ld.lld.exe');
const readobj = path.join(llvm, 'llvm-readobj.exe');
for (const file of [clang, dlltool, linker, readobj, path.join(headers, 'windows.h')]) if (!fs.existsSync(file)) throw new Error('Required local build tool/header not found: ' + file);
const systemImports = {
  kernel32: ['GetProcessHeap@0', 'HeapAlloc@12', 'HeapFree@12', 'GetTickCount64@0', 'GetModuleHandleExW@12', 'GetModuleHandleW@4', 'MulDiv@12', 'lstrcmpiW@8', 'lstrcmpW@8'],
  user32: ['SystemParametersInfoW@16', 'GetSysColor@4', 'GetWindowTextW@12', 'GetDlgCtrlID@4', 'GetWindowLongW@8', 'SetWindowLongW@12', 'IsWindowEnabled@4', 'SendMessageW@16', 'GetWindowRect@8', 'GetClientRect@8', 'InvalidateRect@12', 'FillRect@12', 'DrawTextW@20', 'TrackMouseEvent@4', 'SetTimer@16', 'KillTimer@8', 'IsWindowVisible@4', 'RemovePropW@8', 'GetPropW@8', 'SetPropW@12', 'BeginPaint@8', 'EndPaint@8', 'GetClassNameW@12', 'SetWindowPos@28', 'EnableWindow@8', 'EnumChildWindows@12', 'CreateWindowExW@48', 'DestroyWindow@4', 'IsWindow@4', 'PostMessageW@16', 'ScreenToClient@8', 'InflateRect@12', 'RedrawWindow@16', 'GetDlgItem@8', 'GetAncestor@8', 'ShowWindow@8', 'GetSysColorBrush@4'],
  gdi32: ['GetStockObject@4', 'CreateSolidBrush@4', 'CreatePen@12', 'SelectObject@8', 'RoundRect@28', 'DeleteObject@4', 'MoveToEx@16', 'LineTo@12', 'SetBkMode@8', 'SetTextColor@8', 'CreateCompatibleDC@4', 'CreateCompatibleBitmap@12', 'BitBlt@36', 'DeleteDC@4', 'CreateFontW@56', 'SetBkColor@8'],
  comctl32: ['SetWindowSubclass@16', 'RemoveWindowSubclass@12', 'DefSubclassProc@16'],
  dwmapi: ['DwmSetWindowAttribute@16', 'DwmExtendFrameIntoClientArea@8'],
  gdiplus: ['GdiplusStartup@12', 'GdiplusShutdown@4', 'GdipCreateFromHDC@8', 'GdipDeleteGraphics@4', 'GdipSetSmoothingMode@8', 'GdipCreateSolidFill@8', 'GdipDeleteBrush@4', 'GdipCreatePath@8', 'GdipAddPathArc@28', 'GdipClosePathFigure@4', 'GdipDeletePath@4', 'GdipFillPath@12', 'GdipCreatePen1@16', 'GdipDeletePen@4', 'GdipDrawPath@12', 'GdipDrawLine@24'],
};
function run(file, args) {
  const result = cp.spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error([file, result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}
const libraries = [];
for (const [library, symbols] of Object.entries(systemImports)) {
  const def = path.join(staging, library + '.def');
  const lib = path.join(staging, library + '.lib');
  fs.writeFileSync(def, `LIBRARY ${library}.dll\nEXPORTS\n${symbols.map(s => '  ' + s).join('\n')}\n`);
  run(dlltool, ['-m', 'i386', '--kill-at', '-d', def, '-l', lib]);
  libraries.push(lib);
}
const source = path.join(directory, 'relay-installer-skin.c');
const object = path.join(staging, 'relay-installer-skin.obj');
const output = path.join(directory, 'relay-installer-skin.dll');
run(clang, ['--target=i686-w64-windows-gnu', '-isystem', headers, '-D_WIN32_WINNT=0x0601', '-DWINVER=0x0601', '-std=c11', '-O2', '-ffreestanding', '-fno-builtin', '-fno-stack-protector', '-Wall', '-Wextra', '-Werror', '-c', source, '-o', object]);
run(linker, ['-m', 'i386pe', '--shared', '--entry=_DllMain@12', '--subsystem', 'windows', '--kill-at', '--no-insert-timestamp', '--dynamicbase', '--nxcompat', '--disable-auto-import', '-o', output, object, ...libraries]);
const inspection = run(readobj, ['--file-headers', '--coff-imports', '--coff-exports', output]).replace(/\r\n/g, '\n');
fs.writeFileSync(path.join(staging, 'pe-inspection.txt'), inspection);
if (!inspection.includes('IMAGE_FILE_MACHINE_I386')) throw new Error('Skin DLL must be i386 for the NSIS host.');
const imported = [...inspection.matchAll(/^\s*Name: ([\w.-]+\.dll)\s*$/gmi)].map(m => m[1].toLowerCase());
const allowed = Object.keys(systemImports).map(name => name + '.dll');
if (!imported.length || imported.some(name => !allowed.includes(name))) throw new Error('Unexpected non-system dependency: ' + imported.join(', '));
for (const symbol of ['RelaySkinAttach', 'RelaySkinRefresh', 'RelaySkinDestroy']) if (!inspection.includes('Name: ' + symbol + '\n')) throw new Error('Missing undecorated WINAPI export: ' + symbol);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = {
  format: 1,
  architecture: 'i386',
  callingConvention: 'stdcall',
  exports: { RelaySkinAttach: 'int(HWND, int dpi)', RelaySkinRefresh: 'void(HWND)', RelaySkinDestroy: 'void(HWND)' },
  imports: [...new Set(imported)].sort(),
  compiler: run(clang, ['--version']).split(/\r?\n/)[0],
  files: {
    'relay-installer-skin.c': sha256(source),
    '../build-installer-skin.cjs': sha256(__filename),
    'relay-installer-skin.dll': sha256(output),
  },
};
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${output} (${fs.statSync(output).size} bytes), i386, system DLLs only.`);
console.log(JSON.stringify(manifest, null, 2));
