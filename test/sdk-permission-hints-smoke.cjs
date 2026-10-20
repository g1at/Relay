'use strict';

// No user profile, SDK process, model request, or external network is used.
if (!process.argv.includes('--run')) {
  console.log('Opt in: electron test/sdk-permission-hints-smoke.cjs --run');
  process.exit(0);
}
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { InteractionBroker } = require('../src/main/tasks/interaction-broker');
const relay = require('../src/main/sdk/claude-sdk');
const root = path.resolve(__dirname, '..');
const base = path.join(root, '.codex-tmp', 'sdk-permission-hints-smoke');
fs.mkdirSync(base, { recursive: true });
const output = fs.mkdtempSync(path.join(base, 'run-'));
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, broker, current, counter = 0;
const checks = [], errors = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors }, null, 2));
const fail = error => {
  errors.push(error.stack || String(error)); save(); console.error(error.stack || error);
  broker?.close(); if (win && !win.isDestroyed()) win.destroy(); app.exit(1);
};
const deadline = setTimeout(() => fail(new Error('Permission UI acceptance exceeded 45 seconds')), 45000);
const evaluate = code => win.webContents.executeJavaScript(code);
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const poll=()=>{if(${code})return resolve();if(Date.now()>deadline)return reject(Error(${JSON.stringify(code)}));setTimeout(poll,20)};poll()})`);
}
async function check(name, code) {
  assert.equal(await evaluate(code), true, name); checks.push(name); save();
}
const suggestions = [{ type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash' }] }];
async function prompt(hints = {}) {
  const options = relay._buildOptions({ permissionMode: 'default', canUseTool: broker.createCanUseTool({
    conversationId: 'synthetic', runId: 'synthetic-run', windowId: win.id,
  }) }, {});
  const pending = options.canUseTool('mcp__relay__write', { command: 'synthetic-command' }, {
    toolUseID: `synthetic-${++counter}`, suggestions, ...hints,
  });
  const id = broker.list()[0].id;
  current = { id, pending };
  await evaluate(`window.dispatchEvent(new CustomEvent('relay:focus-interaction',{detail:{conversationId:'synthetic',interactionId:${JSON.stringify(id)}}}))`);
  await waitFor(`!document.getElementById('interactionSurfaceMount').hidden&&document.querySelector('[data-action="deny"]')`);
  return current;
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const preload = path.join(output, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{interactions:{list:()=>ipcRenderer.invoke('fixture:list'),respond:(id,decision)=>ipcRenderer.invoke('fixture:respond',id,decision),onEvent:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('fixture:event',listener);return()=>ipcRenderer.removeListener('fixture:event',listener);}}});`);
  broker = new InteractionBroker({ logger: { warn() {} }, onChange: event => {
    if (win && !win.isDestroyed()) win.webContents.send('fixture:event', event);
  } });
  ipcMain.handle('fixture:list', () => ({ ok: true, items: broker.list() }));
  ipcMain.handle('fixture:respond', (_event, id, decision) => {
    try { return { ok: broker.respond(id, decision) }; }
    catch (error) { return { ok: false, code: error.code, error: error.message }; }
  });
  const page = path.join(output, 'fixture.html');
  fs.writeFileSync(page, `<!doctype html><html lang="zh"><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'renderer/interaction-surface.css')).href}"><style>body{font:14px system-ui;background:#f7f7f9;color:#15151b;padding:40px}#interactionSurfaceMount{max-width:800px;margin:auto}</style><div id="interactionSurfaceMount" hidden></div><script src="${pathToFileURL(path.join(root, 'renderer/interaction-surface.js')).href}"></script><script>window.dispatchEvent(new CustomEvent('relay:conversation-changed',{detail:{conversationId:'synthetic'}}));</script></html>`);
  win = new BrowserWindow({ show: false, width: 1020, height: 700, webPreferences: {
    preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  await win.loadFile(page);

  const guarded = await prompt({ defaultToNo: true, suppressAlwaysAllowRule: true,
    mcpServer: { name: '<img src=x onerror=alert(1)>', source: 'plugin' },
  });
  await waitFor(`document.activeElement?.dataset.action==='deny'`);
  await check('declineIsInitiallyFocusedAndVisuallyDefault', `document.activeElement.dataset.action==='deny'&&document.activeElement.classList.contains('interaction-button-primary')`);
  await check('noOneKeyApprovalOrRememberMenu', `!document.querySelector('[data-action="allow_once"] kbd')&&!document.querySelector('.interaction-allow-menu-toggle')&&!document.querySelector('[data-action="allow_session"]')`);
  await check('mcpProvenanceIsEscapedTextWithoutTrustedNameAssumptions', `document.querySelector('.interaction-permission-facts').textContent.includes('<img src=x onerror=alert(1)>')&&document.querySelector('.interaction-permission-facts').textContent.includes('插件')&&!document.querySelector('.interaction-permission-facts img')`);
  for (const action of ['allow_session', 'allow_suggested']) {
    const response = await evaluate(`api.interactions.respond(${JSON.stringify(guarded.id)},{action:${JSON.stringify(action)},suppressAlwaysAllowRule:false})`);
    assert.equal(response.ok, false); assert.equal(response.code, 'PERSISTENT_PERMISSION_SUPPRESSED');
  }
  assert.equal(broker.size, 1); checks.push('forgedRememberDecisionsAreRejectedAcrossRealIpc');
  await evaluate(`document.querySelector('.interaction-title').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  assert.equal((await guarded.pending).behavior, 'deny'); checks.push('enterOnTitleDeclinesAtSdkCallback');
  await waitFor(`document.getElementById('interactionSurfaceMount').hidden`);

  const once = await prompt({ defaultToNo: true, suppressAlwaysAllowRule: true });
  await waitFor(`document.activeElement?.dataset.action==='deny'`);
  await evaluate(`document.querySelector('[data-action="allow_once"]').click()`);
  const answer = await once.pending;
  assert.equal(answer.behavior, 'allow'); assert.equal(answer.updatedPermissions, undefined);
  checks.push('deliberateOneTimeApprovalReturnsNoPersistentRules');
  await waitFor(`document.getElementById('interactionSurfaceMount').hidden`);

  const normal = await prompt();
  await waitFor(`document.activeElement?.classList.contains('interaction-title')`);
  await check('ordinaryPromptRetainsSessionChoiceAndEnterHint', `!!document.querySelector('[data-action="allow_once"] kbd')&&!!document.querySelector('.interaction-allow-menu-toggle')`);
  await evaluate(`document.querySelector('.interaction-title').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  assert.equal((await normal.pending).behavior, 'allow'); checks.push('ordinaryEnterStillAllowsExactlyOnce');
  await waitFor(`document.getElementById('interactionSurfaceMount').hidden`);
  await check('rendererHasNoNodeAccess', `typeof require==='undefined'&&typeof process==='undefined'`);
  save(); console.log(JSON.stringify({ ok: true, checks: checks.length, result: path.join(output, 'result.json') }));
  clearTimeout(deadline); broker.close(); win.destroy(); app.exit(0);
}).catch(fail);
