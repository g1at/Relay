'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') { console.log('SKIP: native NSIS command-line fixture'); process.exit(0); }
const repo = path.resolve(__dirname, '..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-nsis-directory-'));
const text = fs.readFileSync(path.join(repo, 'build/installer-safe-user-path.nsh'), 'utf8');
const read = text.match(/!macro RelayReadInstallDir\b[\s\S]*?!macroend/)[0];
const source = path.join(folder, 'probe.nsi');
const executable = path.join(folder, 'probe.exe');
fs.writeFileSync(source, '\uFEFF' + `Unicode true\nName "Relay directory parameter fixture"\nOutFile "${executable}"\nRequestExecutionLevel user\nSilentInstall silent\n!include FileFunc.nsh\n!include LogicLib.nsh\n${read}\nSection\nStrCpy $INSTDIR "UNCHANGED"\n!insertmacro RelayReadInstallDir\nFileOpen $0 "$EXEDIR\\result.txt" w\nFileWriteUTF16LE $0 "$INSTDIR"\nFileClose $0\nSectionEnd\n`);
const compiler = path.join(process.env.LOCALAPPDATA, 'electron-builder/cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const compiled = spawnSync(compiler, ['/V2', source], { encoding: 'utf8' });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const target = path.join(folder, '目录 空格', 'Relay');
for (const args of [['/S'], ['/S', '/D=' + target], ['/S', '/D="' + target + '"']]) {
  const run = spawnSync(executable, args, { windowsVerbatimArguments: true, timeout: 10000 });
  assert.equal(run.status, 0);
  assert.equal(fs.readFileSync(path.join(folder, 'result.txt'), 'utf16le'), args.length === 1 ? 'UNCHANGED' : target);
}
console.log('PASS: default, quoted and unquoted /D= with non-ASCII characters and spaces; no installation or registry writes.');
fs.rmSync(folder, { recursive: true, force: true });
