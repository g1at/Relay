'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { registerWorkspaceTools } = require('../src/main/workspace/workspace-tools');
const nativePty = require('node-pty');
const spawnedPids = [];
const outputDir = path.join(__dirname, '..', '.codex-tmp', 'workspace-pty-smoke');
fs.mkdirSync(outputDir, { recursive: true });
app.setPath('userData', path.join(outputDir, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const report = { versions: { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi }, checks: [], failures: [] };
let registry, transcript = '', stage = 'starting', terminalId, interruptOffset = 0;
function check(name, ok, detail) { report.checks.push({ name, ok: !!ok, detail }); if (!ok) throw new Error(name + ': ' + String(detail || 'failed')); }
function plain(value) { return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, ''); }
const handlers = new Map();
const sender = new EventEmitter(); sender.isDestroyed = () => false;
sender.mainFrame = { url: pathToFileURL(path.join(__dirname, '../renderer/index.html')).href };
const event = { sender, senderFrame: sender.mainFrame };
const call = (name, payload) => handlers.get(`workspace:${name}`)(event, payload);
const completed = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('PTY smoke timed out during ' + stage)), 45000);
  sender.send = (_channel, payload) => {
    try {
      if (payload.type === 'exit') {
        if (stage !== 'exit') return;
        check('shell_exit_code', payload.exitCode === 7, payload.exitCode);
        clearTimeout(timeout); resolve(); return;
      }
      if (payload.type !== 'data') return;
      transcript += payload.data;
      if (payload.data.includes('\x1b[6n')) void call('terminalInput', { id: payload.id, data: '\x1b[1;1R' });
      const text = plain(transcript);
      if (stage === 'identity' && text.includes('RELAY_PTY_READY') && text.includes('TTY_False') && text.includes('ROOT_OK')) {
        stage = 'resize';
        check('interactive_tty', true, 'PowerShell Console.IsInputRedirected=False');
        check('workspace_cwd', true, 'Get-Location matches synthetic fixture root');
        void call('terminalResize', { id: terminalId, cols: 101, rows: 31 }).then((result) => {
          check('resize_request', result.ok, result.error);
          return call('terminalInput', { id: terminalId, data: "[Console]::WriteLine(('SIZE_' + [Console]::WindowWidth + 'x' + [Console]::WindowHeight))\r" });
        }).catch(reject);
      }
      if (stage === 'resize' && text.includes('SIZE_101x31')) {
        stage = 'sleep'; check('native_resize_observed', true, 'PowerShell WindowWidth=101 WindowHeight=31');
        void call('terminalInput', { id: terminalId, data: "[Console]::WriteLine(('SLEEP_' + 'START')); Start-Sleep -Seconds 30; [Console]::WriteLine(('SLEEP_' + 'END'))\r" });
      }
      if (stage === 'sleep' && text.includes('SLEEP_START')) {
        stage = 'interrupt'; interruptOffset = transcript.length;
        void call('terminalInput', { id: terminalId, data: '\x03' }).catch(reject);
      }
      if (stage === 'interrupt' && /PS [^\n]*> ?$/.test(plain(transcript.slice(interruptOffset)))) {
        stage = 'verify-interrupt';
        void call('terminalInput', { id: terminalId, data: "[Console]::WriteLine(('AFTER_' + 'INTERRUPT'))\r" }).catch(reject);
      }
      if (stage === 'verify-interrupt' && text.includes('AFTER_INTERRUPT')) {
        stage = 'exit'; check('ctrl_c_interrupt', !text.includes('SLEEP_END'), 'Long command interrupted and prompt accepts next command');
        void call('terminalInput', { id: terminalId, data: 'exit 7\r' });
      }
    } catch (error) { clearTimeout(timeout); reject(error); }
  };
});
app.whenReady().then(async () => {
  const root = path.join(outputDir, 'synthetic-workspace'); fs.mkdirSync(root, { recursive: true });
  registry = registerWorkspaceTools({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) },
    ptyModule: { spawn(...args) { const terminal = nativePty.spawn(...args); spawnedPids.push(terminal.pid); return terminal; } },
    getWindow: () => ({ webContents: sender, isDestroyed: () => false }), resolveWorkspace: async () => ({ root, conversationId: 'pty-smoke-fixture', managed: true }), shell: { openPath: async () => '' },
  });
  const started = await call('terminalStart', { context: { conversationId: 'pty-smoke-fixture' }, cols: 80, rows: 24 });
  check('electron_native_addon_start', started.ok && !!started.id, started.error || started.shell);
  terminalId = started.id; stage = 'identity';
  const escapedRoot = root.replace(/'/g, "''");
  await call('terminalInput', { id: terminalId, data: `[Console]::WriteLine(('RELAY_' + 'PTY_READY')); [Console]::WriteLine(('TTY_' + [Console]::IsInputRedirected)); if ((Get-Location).Path -eq '${escapedRoot}') { [Console]::WriteLine(('ROOT_' + 'OK')) }\r` });
  await completed;
  stage = 'closing';
  const another = await call('terminalStart', { context: { conversationId: 'pty-smoke-fixture' } });
  check('second_terminal_start', another.ok, another.error);
  const ownedPid = spawnedPids[spawnedPids.length - 1];
  await call('terminalClose', { id: another.id });
  let gone = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { process.kill(ownedPid, 0); } catch (error) { if (error.code === 'ESRCH') { gone = true; break; } throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('close_terminates_native_shell', gone, 'Owned PowerShell PID no longer exists');
  stage = 'complete';
}).catch((error) => { report.failures.push(error.message); }).finally(() => {
  if (registry) registry.dispose();
  report.stage = stage;
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outputDir, 'transcript.txt'), transcript);
  console.log(JSON.stringify(report));
  app.exit(report.failures.length ? 1 : 0);
});
