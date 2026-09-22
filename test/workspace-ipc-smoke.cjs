'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerWorkspaceTools } = require('../src/main/workspace/workspace-tools');
const out = process.env.RELAY_SMOKE_OUTPUT ? path.resolve(process.env.RELAY_SMOKE_OUTPUT) : path.join(__dirname, '..', '.codex-tmp', 'workspace-ipc-smoke');
const root = path.join(out, 'synthetic-workspace'); fs.mkdirSync(root, { recursive: true });
const fixture = path.join(out, 'index.html'); fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"><title>Workspace IPC fixture</title></head><body>Isolated workspace API verification</body></html>');
fs.writeFileSync(path.join(root, 'sample.md'), '# IPC fixture\nLocal synthetic data only.');
fs.mkdirSync(path.join(root, 'nested'), { recursive: true }); fs.writeFileSync(path.join(root, 'nested', 'sample.txt'), 'Nested fixture');
app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
const report = { checks: [], failures: [], versions: { electron: process.versions.electron, napi: process.versions.napi } };
let win, foreign, registry;
function check(name, ok, detail) { report.checks.push({ name, ok: !!ok, detail }); if (!ok) throw new Error(name + ': ' + String(detail || 'failed')); }
function act(code, window = win) { return window.webContents.executeJavaScript(code, true); }
async function until(code, label) { for (let attempt = 0; attempt < 150; attempt++) { if (await act(code)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(label + ' timed out'); }
function createWindow() { return new BrowserWindow({ show: false, width: 720, height: 480, webPreferences: { preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } }); }
app.whenReady().then(async () => {
  win = createWindow(); const opened = [];
  registry = registerWorkspaceTools({ ipcMain, getWindow: () => win, rendererURL: pathToFileURL(fixture).href,
    resolveWorkspace: async (context) => { if (context.conversationId !== 'ipc-fixture') throw new Error('Unexpected test context'); return { root, conversationId: context.conversationId, managed: true }; },
    shell: { openPath: async (file) => { opened.push(file); return ''; } },
  });
  await win.loadFile(fixture);
  check('production_preload_isolation', await act("typeof require === 'undefined' && typeof process === 'undefined' && typeof window.api.workspace.terminalStart === 'function'"));
  await act("window.ctx={conversationId:'ipc-fixture'}; window.terminalEvents=[]; window.stopEvents=api.workspace.onTerminalEvent(event=>terminalEvents.push(event)); true");
  const resolved = await act('api.workspace.resolve(ctx)'); check('trusted_main_frame_resolve', resolved.ok && resolved.conversationId === 'ipc-fixture' && resolved.managed, resolved.error);
  const listed = await act("api.workspace.list({context:ctx,path:''})"); check('real_ipc_directory_listing', listed.ok && listed.entries.some((item) => item.name === 'sample.md') && listed.entries.some((item) => item.type === 'directory'), listed.error);
  const read = await act("api.workspace.read({context:ctx,path:'sample.md'})"); check('real_ipc_text_preview', read.ok && read.content === '# IPC fixture\nLocal synthetic data only.' && read.language === 'markdown', read.error);
  check('real_ipc_traversal_rejected', !(await act("api.workspace.read({context:ctx,path:'../index.html'})")).ok);
  check('real_ipc_system_open', (await act("api.workspace.open({context:ctx,path:'sample.md'})")).ok && opened.length === 1);
  const started = await act('api.workspace.terminalStart({context:ctx,cols:80,rows:24})'); check('real_ipc_conpty_started', started.ok && !!started.id, started.error);
  await act(`window.termId=${JSON.stringify(started.id)}; true`);
  await act("api.workspace.terminalInput({id:termId,data:\"[Console]::WriteLine(('IPC_' + 'READY'))\\r\"})");
  await until("terminalEvents.some(event=>event.type==='data') && terminalEvents.filter(event=>event.type==='data').map(event=>event.data).join('').includes('IPC_READY')", 'terminal output');
  check('real_ipc_streamed_interactive_output', true);
  check('real_ipc_resize', (await act('api.workspace.terminalResize({id:termId,cols:98,rows:27})')).ok);
  await act("api.workspace.terminalInput({id:termId,data:\"[Console]::WriteLine(('IPC_SIZE_' + [Console]::WindowWidth + 'x' + [Console]::WindowHeight))\\r\"})");
  await until("terminalEvents.filter(event=>event.type==='data').map(event=>event.data).join('').includes('IPC_SIZE_98x27')", 'terminal size');
  check('real_ipc_resize_observed_in_shell', true);
  check('real_ipc_terminal_close', (await act('api.workspace.terminalClose({id:termId})')).ok);
  await until("terminalEvents.some(event=>event.id===termId&&event.type==='exit')", 'terminal close event'); check('real_ipc_terminal_exit_event', true);
  check('closed_terminal_input_rejected', !(await act("api.workspace.terminalInput({id:termId,data:'x'})")).ok);
  await act('stopEvents(); true');
  foreign = createWindow(); await foreign.loadFile(fixture);
  check('foreign_window_with_production_preload_rejected', await act("api.workspace.resolve({conversationId:'ipc-fixture'}).then(()=>false,error=>error.message.includes('此窗口不能'))", foreign));
  await win.loadURL('data:text/html,<title>Untrusted test document</title>');
  check('same_window_untrusted_document_rejected', await act("api.workspace.resolve({conversationId:'ipc-fixture'}).then(()=>false,error=>error.message.includes('此窗口不能'))"));
}).catch((error) => report.failures.push(error.message)).finally(() => {
  if (registry) registry.dispose();
  if (foreign && !foreign.isDestroyed()) foreign.destroy(); if (win && !win.isDestroyed()) win.destroy();
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  app.exit(report.failures.length ? 1 : 0);
});
