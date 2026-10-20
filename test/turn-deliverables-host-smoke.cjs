'use strict';
// Native Electron IPC acceptance for service -> real temporary files -> durable
// history -> production preload -> result cards. SDK messages are synthetic;
// main.js, providers, business tools and production user data are never started.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createHistoryStore } = require('../src/main/app/history-store');
const { createTurnDeliveryService } = require('../src/main/app/turn-delivery-service');
const { createDeliveryProgressStore } = require('../src/main/app/turn-delivery-progress');
const { parse } = require('../renderer/local-file-links');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/turn-deliverables-2026-10-15');
fs.mkdirSync(output, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(output, 'host-fixture-'));
app.setPath('userData', path.join(fixtureRoot, 'electron-profile')); app.commandLine.appendSwitch('disable-gpu');
// The fixture deliberately destroys its renderer to verify durable reopening.
app.on('window-all-closed', () => {});
const report = { checks: [], errors: [], networkRequests: 0, emitted: [], fixtureRoot }; let win, delivery;
const save = () => fs.writeFileSync(path.join(output, 'host-result.json'), JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { report.errors.push('host IPC smoke exceeded 60 seconds'); save(); app.exit(1); }, 60000);
const history = createHistoryStore({ getUserDataDir: () => path.join(fixtureRoot, 'history-data'), recoverLegacyOutput: value => value });
const progressDir = path.join(fixtureRoot, 'delivery-progress');
const progress = createDeliveryProgressStore({ rootDir: progressDir });
const evaluate = code => win.webContents.executeJavaScript(code);
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
async function check(name, value) { const ok = typeof value === 'string' ? !!await evaluate(value) : !!value; report.checks.push({ name, ok }); console.log(name + ': ' + ok); save(); }
const turnTs = '2026-10-15T01:00:00.000Z';
const runTurn = runId => ({ runId, ts: turnTs, user: 'Synthetic delivery test', assistant: '', status: 'running' });
const workspace = id => {
  const cwd = path.join(fixtureRoot, id), outputDir = path.join(cwd, 'outputs'), scratchDir = path.join(cwd, 'scratch');
  fs.mkdirSync(outputDir, { recursive: true }); fs.mkdirSync(scratchDir, { recursive: true });
  return { cwd, outputDir, scratchDir };
};
const spaces = { a: workspace('a'), b: workspace('b') };
async function begin(conversationId, runId) { return delivery.begin({ conversationId, runId, turnTs, ...spaces[conversationId] }); }
function writeResult(runId, file, text, toolUseId, parent = null) {
  delivery.observe(runId, { type: 'assistant', jobId: runId, ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Write', input: { file_path: file, content: text } }] } });
  fs.writeFileSync(file, text);
  delivery.observe(runId, { type: 'user', jobId: runId, ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Synthetic successful write' }] } });
}
async function finish(runId) {
  delivery.observe(runId, { type: 'job-done', jobId: runId, exitCode: 0,
    finalResult: { type: 'result', subtype: 'success', is_error: false, result: '' } });
  await delivery.finish(runId); await settle();
}
async function createWindow(page) {
  win = new BrowserWindow({ width: 1000, height: 780, show: false, webPreferences: {
    preload: path.join(root, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
  } });
  await win.loadFile(page); await settle();
}
app.whenReady().then(async () => {
  report.sourceHashes = Object.fromEntries(['src/main/app/turn-delivery-service.js','src/main/app/turn-delivery-progress.js','src/main/tasks/turn-deliverables.js','renderer/turn-deliverables.js','preload.js'].map(file => [file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
  session.defaultSession.webRequest.onBeforeRequest((details, done) => { const cancel = /^https?:/i.test(details.url); if (cancel) report.networkRequests++; done({ cancel }); });
  history.persistConversationRecord({ id: 'a', title: 'Synthetic A', turns: [runTurn('a-first'), runTurn('a-second')] });
  history.persistConversationRecord({ id: 'b', title: 'Synthetic B', turns: [runTurn('b-first')] });
  delivery = createTurnDeliveryService({ load: history.loadConversation, persist: history.persistConversationRecord, progress,
    emit: payload => { report.emitted.push({ conversationId: payload.conversationId, runId: payload.runId, count: payload.snapshot.items.length }); if (win && !win.isDestroyed()) win.webContents.send('deliverables:changed', payload); },
    onError: error => report.errors.push(String(error?.message || error)),
  });
  const authorized = event => !!win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('deliverables:get', (event, input) => authorized(event) ? delivery.get(input) : { ok: false });
  ipcMain.handle('history:load', (event, id) => authorized(event) ? delivery.hydrate(history.loadConversation(id)) : null);
  ipcMain.handle('workspace:readLink', (event, input) => {
    if (!authorized(event)) return { ok: false, error: 'Unknown test caller' };
    const parsed = parse(input?.href), file = parsed && path.resolve(parsed.path);
    if (!file || !file.startsWith(fixtureRoot + path.sep)) return { ok: false, error: 'Outside synthetic fixture' };
    try { return { ok: true, content: fs.readFileSync(file, 'utf8'), path: file }; }
    catch (error) { return { ok: false, error: error.code === 'ENOENT' ? '文件已不存在' : '读取失败' }; }
  });
  const rendererBase = pathToFileURL(path.join(root, 'renderer') + path.sep).href;
  const page = path.join(fixtureRoot, 'renderer.html');
  fs.writeFileSync(page, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="' + rendererBase + '"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="workspace-file-types.css"><link rel="stylesheet" href="local-file-links.css"><link rel="stylesheet" href="turn-deliverables.css"><style>body{display:block;height:100vh;overflow:auto}#host{width:min(720px,calc(100vw - 40px));margin:24px auto}</style></head><body><main id="host"></main><script src="workspace-file-types.js"></script><script src="local-file-links.js"></script><script src="turn-deliverables.js"></script><script>' +
    'window.review={errors:[],previews:[],notices:[]};window.currentConv=null;window.runMap=new Map();window.addEventListener("error",e=>review.errors.push(e.message));' +
    'window.controller=RelayTurnDeliverables.createController({container:host,getConversation:()=>currentConv,getRun:id=>runMap.get(id),bridge:api.deliverables});' +
    'window.links=RelayLocalFileLinks.install(host,{context:()=>({conversationId:currentConv?.id}),preview:async input=>{const reply=await api.workspace.readLink(input);review.previews.push(reply);return reply},onError:message=>review.notices.push(message)});' +
    'window.openConversation=async id=>{controller.clear();host.replaceChildren();currentConv=await api.history.load(id);for(const [turnIndex,turn] of currentConv.turns.entries()){const anchor=document.createElement("span");anchor.className="conversation-turn-anchor";anchor.dataset.turnAnchor=turnIndex;host.append(anchor);controller.render(turn,{conversationId:id,turnIndex});}return currentConv.id;};' +
    'window.section=id=>Array.from(host.querySelectorAll(".turn-deliverables")).find(el=>el.dataset.runId===id);' +
    '</script></body></html>');
  await createWindow(page);
  await check('production preload exposes only bridge APIs without Node', 'typeof api.deliverables.get==="function"&&typeof api.deliverables.onChanged==="function"&&typeof require==="undefined"&&typeof process==="undefined"');
  await evaluate('openConversation("b")');
  await Promise.all([begin('a', 'a-first'), begin('b', 'b-first')]);
  const first = path.join(spaces.a.outputDir, '第一轮报告.md');
  writeResult('a-first', first, '# 第一轮报告\n\nSynthetic real file.', 'a-write', 'child-a');
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await delivery.get({ conversationId: 'a', runId: 'a-first' });
    if (value.snapshot?.items?.length) break;
    await settle();
  }
  // The durable sidecar avoids rewriting the full transcript for every receipt.
  const running = await delivery.hydrate(history.loadConversation('a'));
  const durable = await progress.read('a');
  await check('verified running output is hydrated and persisted before terminal SDK event',
    running.turns[0].deliverables?.items?.length === 1 && durable[0]?.items?.length === 1 && durable[0].status === 'running');
  const recovered = createTurnDeliveryService({ load: history.loadConversation, persist: history.persistConversationRecord,
    progress: createDeliveryProgressStore({ rootDir: progressDir }) });
  const recoveredRunning = await recovered.get({ conversationId: 'a', runId: 'a-first' });
  await check('new service recovers an unfinished result from the same progress directory',
    recoveredRunning.ok && recoveredRunning.snapshot?.status === 'running' && recoveredRunning.snapshot.items[0]?.toolUseId === 'a-write');
  await finish('a-first');
  await check('completed background A cannot leak into selected B over real IPC', '!host.querySelector(".turn-deliverables")&&currentConv.id==="b"');
  const savedFirst = history.loadConversation('a').turns[0].deliverables;
  await check('host persists verified first-turn metadata with no final Markdown', savedFirst?.items?.length === 1 && savedFirst.items[0].path === first && savedFirst.items[0].source === 'write-tool' && savedFirst.items[0].toolUseId === 'a-write');
  const bFile = path.join(spaces.b.outputDir, 'B独立结果.csv');
  writeResult('b-first', bFile, 'name,value\nfixture,1\n', 'b-write'); await finish('b-first');
  await check('selected B receives only its own changed event and card', 'host.querySelectorAll(".relay-file-card").length===1&&section("b-first").textContent.includes("B独立结果.csv")&&!host.textContent.includes("第一轮报告")');
  await evaluate('openConversation("a")'); await settle();
  await check('switching to A obtains the first result from durable history', 'host.querySelectorAll(".relay-file-card").length===1&&section("a-first").textContent.includes("第一轮报告.md")&&!host.textContent.includes("B独立结果")');
  await begin('a', 'a-second');
  const second = path.join(spaces.a.outputDir, '第二轮结果.csv');
  writeResult('a-second', second, 'round,result\n2,verified\n', 'second-write'); await finish('a-second');
  await check('same-conversation second round does not borrow first-round files', 'host.querySelectorAll(".turn-deliverables").length===2&&section("a-first").textContent.includes("第一轮报告.md")&&!section("a-second").textContent.includes("第一轮报告")&&section("a-second").textContent.includes("第二轮结果.csv")');
  await evaluate('api.deliverables.get({conversationId:"a",runId:"a-second"}).then(result=>review.get=result)');
  await check('production IPC get returns exact requested run identity', 'review.get.ok&&review.get.snapshot.conversationId==="a"&&review.get.snapshot.runId==="a-second"&&review.get.snapshot.turnTs===currentConv.turns[1].ts&&review.get.snapshot.items.length===1');
  await evaluate('section("a-first").querySelector("a").click()'); await settle();
  await check('file card preview reads the actual generated file over IPC', 'review.previews.at(-1)?.ok&&review.previews.at(-1).content.includes("Synthetic real file")');
  win.destroy();
  delivery = createTurnDeliveryService({ load: history.loadConversation, persist: history.persistConversationRecord,
    progress: createDeliveryProgressStore({ rootDir: progressDir }) });
  await createWindow(page); await evaluate('openConversation("a")'); await settle();
  await check('fresh renderer reopen restores both card groups without model prose', 'host.querySelectorAll(".turn-deliverables").length===2&&currentConv.turns.every(turn=>turn.assistant==="")&&section("a-first").dataset.turn==="0"&&section("a-second").dataset.turn==="1"');
  fs.unlinkSync(first);
  await evaluate('section("a-first").querySelector("a").click()'); await settle();
  await check('removed real file reports explicit preview error while preserving record', 'review.notices.at(-1)==="文件已不存在"&&!!section("a-first")&&currentConv.turns[0].deliverables.items.length===1');
  await check('history still stores each run separately after renderer restart', history.loadConversation('a').turns.every((turn, index) => turn.deliverables.runId === (index ? 'a-second' : 'a-first') && turn.deliverables.items.length === 1));
  await check('no renderer errors occurred', 'review.errors.length===0');
  report.sourceHashesUnchanged = Object.entries(report.sourceHashes).every(([file, hash]) => hash === crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'));
  report.ok = report.checks.every(check => check.ok) && !report.errors.length && !report.networkRequests && report.sourceHashesUnchanged;
}).catch(error => { report.ok = false; report.errors.push(error.stack || String(error)); }).finally(() => {
  clearTimeout(deadline); save(); win?.destroy(); app.exit(report.ok ? 0 : 1);
});
