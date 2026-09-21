'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const out = path.join(__dirname, '..', '.codex-tmp', 'workspace-asar-smoke');
const archive = path.join(out, 'app.asar');
app.setPath('userData', path.join(out, 'profile'));
const report = { checks: [], failures: [], versions: { electron: process.versions.electron, napi: process.versions.napi } };
let terminal;
function check(name, ok, detail) { report.checks.push({ name, ok: !!ok, detail }); if (!ok) throw new Error(name); }
app.whenReady().then(async () => {
  for (const file of ['lib/windowsConoutConnection.js', 'lib/conpty_console_list_agent.js', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node', 'prebuilds/win32-x64/pty.node', 'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe']) {
    const entry = path.join('node_modules', 'node-pty', file);
    check('unpacked_' + path.basename(file), asar.statFile(archive, entry).unpacked && fs.existsSync(path.join(archive + '.unpacked', entry)));
  }
  const pty = require(path.join(archive, 'node_modules', 'node-pty'));
  terminal = pty.spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', 'echo ASAR_NATIVE_OK'], { cwd: out, cols: 80, rows: 24, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }, useConpty: true });
  check('asar_require_and_native_spawn', !!terminal.pid);
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('ASAR terminal timeout')), 10000);
    terminal.onData((text) => { output += text; });
    terminal.onExit((event) => {
      clearTimeout(timeout);
      try { check('asar_terminal_output_and_exit', output.includes('ASAR_NATIVE_OK') && event.exitCode === 0); resolve(); } catch (error) { reject(error); }
    });
  });
}).catch((error) => report.failures.push(error.message)).finally(() => {
  if (terminal) { try { terminal.kill(); } catch (_) {} }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); app.exit(report.failures.length ? 1 : 0);
});
