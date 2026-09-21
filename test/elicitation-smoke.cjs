'use strict';
// Isolated UI/IPC contract fixture. No Relay profile, real MCP or website access.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { InteractionBroker } = require('../interaction-broker');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'elicitation-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'startup', id = 0;
const checks = {}, failures = [], answers = [], opens = [];
const broker = new InteractionBroker({ idFactory: () => `request-${++id}`,
  onChange: event => win?.webContents.send('fixture:event', event) });
const context = { runId: 'run-A', conversationId: 'A', windowId: 1 };
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, failures }, null, 2));
const deadline = setTimeout(() => { failures.push(`Timeout: ${step}`); save(); broker.close(); app.exit(1); }, 45000);
const evaluate = source => win.webContents.executeJavaScript(source);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
const act = source => evaluate(`(() => { ${source}\n })()`);
async function check(name, source) { step = name; checks[name] = !!await evaluate(source); save(); if (!checks[name]) throw Error(name); }
function begin(request, ownContext = context) {
  return broker.registerElicitation({ request, context: ownContext, sdkOptions: { requestId: 'rpc-' + (id + 1) } });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const preload = path.join(output, 'preload.cjs');
  fs.writeFileSync(preload, `const { contextBridge, ipcRenderer }=require('electron');contextBridge.exposeInMainWorld('api',{
    interactions:{list:()=>ipcRenderer.invoke('fixture:list'),respond:(id,decision)=>ipcRenderer.invoke('fixture:respond',id,decision),onEvent:callback=>{const handler=(_,event)=>callback(event);ipcRenderer.on('fixture:event',handler);return()=>ipcRenderer.removeListener('fixture:event',handler);}},
    openExternal:url=>ipcRenderer.invoke('fixture:open',url)
  });`);
  ipcMain.handle('fixture:list', () => ({ ok: true, items: broker.list() }));
  ipcMain.handle('fixture:respond', (_, key, decision) => {
    try { broker.respond(key, decision); answers.push({ key, decision }); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('fixture:open', (_, url) => { opens.push(url); return { ok: true }; });
  const page = path.join(output, 'fixture.html');
  const base = pathToFileURL(path.join(root, 'renderer') + path.sep).href;
  fs.writeFileSync(page, `<!doctype html><html><head><base href="${base}"><link rel="stylesheet" href="interaction-surface.css"><style>
    :root{--bg:#fafafa;--bg-panel:#fff;--text:#242424;--text-dim:#555;--text-muted:#777;--border:#ddd;--max-chat-w:700px}body{margin:0;padding:20px;font-family:system-ui}.input-area{max-width:700px;margin:auto}#composer{height:70px;border:1px solid #ddd;border-radius:18px}
    </style></head><body><div class="input-area"><div id="interactionSurfaceMount"></div><div id="composer"></div></div><script src="interaction-surface.js"></script></body></html>`);
  win = new BrowserWindow({ width: 820, height: 860, show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page);
  await act("window.dispatchEvent(new CustomEvent('relay:conversation-changed',{detail:{conversationId:'A'}}));");
  const formRequest = { serverName: 'fixture MCP', message: '<img src=x onerror=alert(1)> 只应显示文字', requestedSchema: {
    type: 'object', properties: { name: { type: 'string', minLength: 2, title: '名称' }, active: { type: 'boolean' },
      mode: { type: 'string', oneOf: [{ const: '', title: '空值' }, { const: 'a', title: '甲' }] },
      tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, minItems: 1 } }, required: ['name', 'active'] } };
  const pending = begin(formRequest); await settle();
  await check('formIsDisplayedWithoutExecutingMessageHtml', "!interactionSurfaceMount.hidden&&document.querySelector('.interaction-elicitation-message').textContent.includes('<img')&&!document.querySelector('img')");
  await act("document.querySelector('[data-elicitation-submit]').click();"); await settle();
  await check('invalidFormRemainsPendingWithInlineError', "!interactionSurfaceMount.hidden&&document.querySelector('.interaction-live-status').textContent.includes('至少输入')");
  await act("const input=document.querySelector('[data-elicitation-field=name]');input.value='此处草稿';input.dispatchEvent(new Event('input',{bubbles:true}));window.dispatchEvent(new CustomEvent('relay:conversation-changed',{detail:{conversationId:'B'}}));");
  await check('switchingConversationsImmediatelyHidesForm', 'interactionSurfaceMount.hidden');
  const other = begin({ serverName: 'other MCP', message: '另一条会话', requestedSchema: { type: 'object', properties: {} } }, { ...context, conversationId: 'B', runId: 'run-B' });
  await settle();
  await check('anotherConversationHasItsOwnRequestAndNoDraft', "!interactionSurfaceMount.hidden&&interactionSurfaceMount.textContent.includes('另一条会话')&&!document.querySelector('[data-elicitation-field=name]')");
  await act("window.dispatchEvent(new CustomEvent('relay:conversation-changed',{detail:{conversationId:'A'}}));"); await settle();
  await check('returningRestoresOnlyOriginalFormDraft', "document.querySelector('[data-elicitation-field=name]').value==='此处草稿'");
  await act("const active=document.querySelector('[data-elicitation-field=active]');active.value='false';active.dispatchEvent(new Event('change',{bubbles:true}));const mode=document.querySelector('[data-elicitation-field=mode]');mode.value='0';mode.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-elicitation-field=tags] input').click();document.querySelector('[data-elicitation-submit]').click();");
  const accepted = await pending; await settle();
  if (JSON.stringify(accepted) !== JSON.stringify({ action: 'accept', content: { name: '此处草稿', active: false, mode: '', tags: ['x'] } })) throw Error('Typed form result: ' + JSON.stringify(accepted));
  checks.typedFormSubmission = true;
  await check('resolvedFormDisappearsWithoutLeakingOtherConversation', 'interactionSurfaceMount.hidden');
  broker.rejectTask('run-B'); await other;
  const unsupported = begin({ serverName: 'fixture MCP', message: '不支持的约束', requestedSchema: { type: 'object', properties: { value: { type: 'string', pattern: '^safe$' } } } }); await settle();
  await check('unsupportedConstraintsDisableSubmission', "document.querySelector('[data-elicitation-submit]').disabled&&interactionSurfaceMount.textContent.includes('pattern')");
  await act("document.querySelector('.interaction-close').click();");
  if ((await unsupported).action !== 'cancel') throw Error('Close must cancel elicitation');
  const urlRequest = begin({ serverName: 'auth fixture', message: '打开离线模拟网页', mode: 'url', elicitationId: 'url-1', url: 'https://fixture.invalid/authorize?secret=fixture-token' }); await settle();
  await check('urlDisplaysOriginWithoutLeakingQueryAndAwaitsClick', "interactionSurfaceMount.textContent.includes('https://fixture.invalid/authorize')&&!interactionSurfaceMount.textContent.includes('fixture-token')");
  if (opens.length) throw Error('URL opened before explicit click');
  await act("document.querySelector('[data-elicitation-submit]').click();"); await urlRequest; await settle();
  if (opens.length !== 1) throw Error('URL action must open exactly once');
  checks.urlOnlyOpensOnUserClick = true;
  const completed = broker.completeElicitation({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'auth fixture', elicitation_id: 'url-1' }, context);
  if (!completed || broker.urlElicitations.size) throw Error('URL completion not correlated');
  checks.urlCompletionCorrelated = true;
  await check('noNodeIntegrationAndNoPendingCards', "typeof require==='undefined'&&interactionSurfaceMount.hidden");
  step = 'completed'; save(); clearTimeout(deadline); broker.close(); win.destroy(); app.exit(0);
}).catch(async error => { failures.push(error.stack || String(error)); console.error(error); save(); clearTimeout(deadline); broker.close(); app.exit(1); });
