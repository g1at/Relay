'use strict';

// Real sandboxed renderer, synthetic history/completion APIs, isolated profile.
// Relay main, real conversations, credentials, and model execution are not used.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = process.env.RELAY_SMOKE_OUT || path.join(root, '.codex-tmp', 'history-completion-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const report = { runtime: process.versions.electron, checks: {}, failures: [], step: 'starting' };
let win;
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { report.failures.push('Timeout: ' + report.step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;function check(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(check,20)}check()})`);
}
async function check(name, code) {
  report.step = name;
  report.checks[name] = !!await evaluate(code);
  console.log(name + ': ' + report.checks[name]); save();
  if (!report.checks[name]) throw Error(name);
}
async function settle() {
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function capture(name, sidebarOnly = false) {
  await settle();
  await new Promise(resolve => setTimeout(resolve, 100));
  const rect = sidebarOnly === 'history' ? await evaluate("(()=>{const side=document.getElementById('sidebarNavigation').getBoundingClientRect(),rows=[...document.querySelectorAll('.history-item')],first=rows[0].getBoundingClientRect(),last=rows.at(-1).getBoundingClientRect(),top=first.top-30;return {x:Math.floor(side.x),y:Math.floor(top),width:Math.ceil(side.width),height:Math.ceil(last.bottom-top+15)}})()")
    : sidebarOnly ? await evaluate("(()=>{const r=document.getElementById('sidebarNavigation').getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()") : undefined;
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage(rect)).toPNG());
}
function seed() {
  const base = window.api;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const ids = {
    current: '10000000-0000-4000-8000-000000000031',
    done: '10000000-0000-4000-8000-000000000032',
    failed: '10000000-0000-4000-8000-000000000033',
    create: '10000000-0000-4000-8000-000000000034',
  };
  const records = new Map([
    [ids.current, { id: ids.current, title: '正在查看的会话', kind: 'chat', mode: 'plain', model: 'opus', updatedAt: '2026-10-23T04:00:00.000Z', turns: [{ user: '合成当前问题', assistant: '当前会话的合成回答', ts: '2026-10-23T04:00:00.000Z' }] }],
    [ids.done, { id: ids.done, title: '后台完成：整理本周更新与后续计划，这是一段用于验证窄侧栏的长标题', kind: 'chat', mode: 'plain', model: 'opus', updatedAt: '2026-10-23T03:00:00.000Z', turns: [{ user: '合成后台问题', assistant: '后台任务的完整合成结果', ts: '2026-10-23T03:00:00.000Z' }] }],
    [ids.failed, { id: ids.failed, title: '需要查看的任务结果', kind: 'chat', mode: 'plain', model: 'opus', updatedAt: '2026-10-23T02:00:00.000Z', turns: [{ user: '合成失败问题', assistant: '模拟任务失败后的说明', ts: '2026-10-23T02:00:00.000Z' }] }],
    [ids.create, { id: ids.create, title: '已完成的图片创作', kind: 'create', updatedAt: '2026-10-23T01:00:00.000Z', turns: [{ prompt: '合成创作描述', model: 'fixture', size: '1024x1024', resultPaths: [] }] }],
  ]);
  const state = window.completionFixture = {
    ids, records, revision: 1, focused: true, visible: true, reads: [], loads: [], writes: [], listeners: new Set(),
    listCalls: 0, snapshotCalls: 0, holdLoad: null, holdRead: false, pendingLoads: [], pendingReads: [], rejectRead: false,
    items: new Map([
      [ids.done, { conversationId: ids.done, runId: 'done-1', status: 'succeeded', completedAt: '2026-10-23T03:01:00.000Z' }],
      [ids.failed, { conversationId: ids.failed, runId: 'failed-1', status: 'failed', completedAt: '2026-10-23T02:01:00.000Z' }],
      [ids.create, { conversationId: ids.create, runId: 'create-1', status: 'succeeded', completedAt: '2026-10-23T01:01:00.000Z' }],
    ]),
    snapshot() { return clone({ revision: state.revision, items: [...state.items.values()] }); },
    emit() { const value = state.snapshot(); for (const listener of state.listeners) listener(value); },
    complete(id, runId, status = 'succeeded') {
      state.items.set(id, { conversationId: id, runId, status, completedAt: new Date().toISOString() }); state.revision++; state.emit();
    },
    view(focused, visible = true) {
      state.focused = focused; state.visible = visible;
      window.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
      document.dispatchEvent(new Event('visibilitychange'));
    },
    releaseLoad() {
      const pending = state.pendingLoads.shift(); if (!pending) throw Error('No held load');
      pending.resolve(clone(records.get(pending.id) || null));
    },
    releaseRead() {
      const pending = state.pendingReads.shift(); if (!pending) throw Error('No held read');
      pending.resolve(pending.finish());
    },
    row(id) { return document.querySelector('.history-item[data-id="' + id + '"]'); },
    dot(id) { return state.row(id)?.querySelector('.hi-unread-dot'); },
    rowOrder() { return [...document.querySelectorAll('.history-item')].map(row => row.dataset.id).join(','); },
  };
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => state.focused });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state.visible ? 'visible' : 'hidden' });
  const history = new Proxy(base.history, { get(target, key) {
    if (key === 'list') return async () => { state.listCalls++; return clone([...records.values()]); };
    if (key === 'load') return async id => {
      state.loads.push(id);
      if (state.holdLoad === id) return new Promise(resolve => state.pendingLoads.push({ id, resolve }));
      return clone(records.get(id) || null);
    };
    if (key === 'save') return async record => { state.writes.push(clone(record)); records.set(record.id, clone(record)); return clone(record); };
    if (key === 'completionSnapshot') return async () => { state.snapshotCalls++; return state.snapshot(); };
    if (key === 'onCompletionChanged') return handler => { state.listeners.add(handler); return () => state.listeners.delete(handler); };
    if (key === 'markCompletionRead') return async (id, runId) => {
      state.reads.push({ id, runId, text: document.getElementById('messages')?.textContent || '', activeView });
      if (state.rejectRead) return { ok: false, ...state.snapshot() };
      const finish = () => {
        const changed = state.items.get(id)?.runId === runId;
        if (changed) { state.items.delete(id); state.revision++; state.emit(); }
        return { ok: true, changed, ...state.snapshot() };
      };
      if (state.holdRead) return new Promise(resolve => state.pendingReads.push({ id, runId, resolve, finish }));
      return finish();
    };
    return target[key];
  } });
  window.api = new Proxy(base, { get(target, key) { return key === 'history' ? history : target[key]; } });
  localStorage.clear();
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  await session.defaultSession.clearCache();
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(root, 'test', name), 'utf8')).join('\n') + `\n(${seed.toString()})();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}</script>`);
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1220, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page);
  await waitFor('providerRoutingLoaded&&!restoringActiveRuns&&!restoringTaskLifecycle&&completionFixture.snapshotCalls>0&&!!completionFixture.dot(completionFixture.ids.done)');
  await evaluate('loadConversation(completionFixture.ids.current)');
  report.logo = await evaluate("(()=>{const image=document.getElementById('brandLogo');return {src:image.currentSrc||image.src,width:image.naturalWidth,complete:image.complete}})()");
  await check('initialSnapshotRestoresOnlyUnreadConversationDots', "!completionFixture.dot(completionFixture.ids.current)&&['done','failed','create'].every(key=>!!completionFixture.dot(completionFixture.ids[key]))&&completionFixture.reads.length===0");
  await check('successDotHasAccessibleMeaningAndRightTailPlacement', "(()=>{const row=completionFixture.row(completionFixture.ids.done),dot=completionFixture.dot(completionFixture.ids.done),r=row.getBoundingClientRect(),d=dot.getBoundingClientRect();return dot.closest('.hi-tail').dataset.state==='unread'&&dot.getAttribute('aria-label')==='任务已完成，尚未查看'&&d.left>r.left+r.width/2&&d.right<=r.right&&d.width>=5&&d.width<=10;})()");
  await check('failedCompletionAlsoHasAnAccessibleUnreadIndicator', "completionFixture.dot(completionFixture.ids.failed).getAttribute('aria-label').includes('尚未查看')");
  await act("completionFixture.before={order:completionFixture.rowOrder(),titles:[...completionFixture.records.values()].map(item=>item.title).join('|'),loads:completionFixture.loads.length,list:completionFixture.listCalls};completionFixture.complete(completionFixture.ids.done,'done-2');");
  await check('completionEventsDoNotReloadHistoryOrMutateTitlesAndOrdering', "completionFixture.loads.length===completionFixture.before.loads&&completionFixture.listCalls===completionFixture.before.list&&completionFixture.rowOrder()===completionFixture.before.order&&[...completionFixture.records.values()].map(item=>item.title).join('|')===completionFixture.before.titles");
  await act("completionFixture.row(completionFixture.ids.done).remove();");
  await evaluate('refreshHistoryList()');
  await check('UnreadCompletionSurvivesListRowRebuild', "!!completionFixture.dot(completionFixture.ids.done)&&completionFixture.rowOrder()===completionFixture.before.order");
  await act("runs.set(completionFixture.ids.done,{convId:completionFixture.ids.done,jobId:'next-running',turn:{}});syncHistoryDeletionAvailability(completionFixture.ids.done);");
  await check('RunningSpinnerTakesVisualPriorityWithoutDroppingUnread', "completionFixture.row(completionFixture.ids.done).querySelector('.hi-tail').dataset.state==='spin'&&!!completionFixture.row(completionFixture.ids.done).querySelector('.hi-spinner')&&!completionFixture.dot(completionFixture.ids.done)&&historyCompletions.get(completionFixture.ids.done).runId==='done-2'");
  await act("runs.delete(completionFixture.ids.done);syncHistoryDeletionAvailability(completionFixture.ids.done);setHistoryDeletionPending(completionFixture.ids.done,true);");
  await check('DeletionStatusTakesPriorityOverUnreadDot', "completionFixture.row(completionFixture.ids.done).querySelector('.hi-tail').dataset.state==='deleting'&&!completionFixture.dot(completionFixture.ids.done)");
  await act("setHistoryDeletionPending(completionFixture.ids.done,false);");
  await check('ClearingTemporaryRowStatusRestoresUnreadDot', "!!completionFixture.dot(completionFixture.ids.done)");

  for (const theme of ['light', 'dark']) {
    await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    await check(theme + 'DotRemainsBlueAndVisible', "(()=>{const style=getComputedStyle(completionFixture.dot(completionFixture.ids.done)),rgb=style.backgroundColor.match(/\\d+/g).map(Number);return style.display!=='none'&&Number(style.opacity)>0&&rgb[2]>rgb[0]+40&&rgb[2]>rgb[1];})()");
    await capture('sidebar-completion-' + theme);
    await capture('sidebar-completion-' + theme + '-detail', true);
    await capture('sidebar-completion-' + theme + '-rows', 'history');
  }
  await act("document.documentElement.dataset.theme='light';document.querySelector('.app').style.setProperty('--sidebar-width','190px');document.querySelector('.app').style.setProperty('--sidebar-visible-width','190px');");
  await new Promise(resolve => setTimeout(resolve, 250));
  const point = await evaluate("(()=>{const r=completionFixture.row(completionFixture.ids.done).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  win.show(); win.focus(); win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 700 });
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  await waitFor("completionFixture.row(completionFixture.ids.done).matches(':hover')");
  await settle();
  report.hover = await evaluate("(()=>{const row=completionFixture.row(completionFixture.ids.done);return {hover:row.matches(':hover'),width:row.getBoundingClientRect().width,elements:['.hi-title','.hi-rename','.hi-pin','.hi-unread-dot','.hi-del'].map(selector=>{const item=row.querySelector(selector),r=item.getBoundingClientRect();return {selector,display:getComputedStyle(item).display,left:r.left,right:r.right,width:r.width}})}})()");
  await check('NarrowHoveredRowKeepsDotAndActionsSeparate', "(()=>{const row=completionFixture.row(completionFixture.ids.done),dot=completionFixture.dot(completionFixture.ids.done).getBoundingClientRect(),buttons=['.hi-rename','.hi-pin','.hi-del'].map(s=>row.querySelector(s));return buttons.every(button=>{const s=getComputedStyle(button),r=button.getBoundingClientRect();return s.display!=='none'&&!button.disabled&&r.width>0&&(r.right<=dot.left||r.left>=dot.right);})&&row.querySelector('.hi-title').getBoundingClientRect().right<=dot.left;})()");
  await capture('sidebar-completion-narrow-hover');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 700 });

  await act("completionFixture.holdLoad=completionFixture.ids.done;completionFixture.navigation=loadConversation(completionFixture.ids.done);");
  await waitFor('completionFixture.pendingLoads.length===1');
  await check('PendingHistoryLoadCannotAcknowledgeUnreadResult', "!!completionFixture.dot(completionFixture.ids.done)&&completionFixture.reads.length===0");
  await act("completionFixture.holdLoad=null;completionFixture.releaseLoad();");
  await evaluate('completionFixture.navigation');
  await waitFor('!completionFixture.dot(completionFixture.ids.done)');
  await check('SuccessfulVisibleLoadAcknowledgesOnlyItsExactCompletionAfterRendering', "completionFixture.reads.length===1&&completionFixture.reads[0].id===completionFixture.ids.done&&completionFixture.reads[0].runId==='done-2'&&completionFixture.reads[0].text.includes('后台任务的完整合成结果')&&!!completionFixture.dot(completionFixture.ids.failed)&&!!completionFixture.dot(completionFixture.ids.create)&&completionFixture.rowOrder()===completionFixture.before.order&&completionFixture.writes.length===0");
  await act("completionFixture.view(false);completionFixture.complete(completionFixture.ids.done,'done-unfocused');");
  await check('UnfocusedCurrentConversationRetainsUnreadDot', "!!completionFixture.dot(completionFixture.ids.done)&&completionFixture.reads.length===1");
  await act("completionFixture.view(true,false);");
  await check('HiddenDocumentDoesNotMarkCompletionRead', "!!completionFixture.dot(completionFixture.ids.done)&&completionFixture.reads.length===1");
  await act("completionFixture.view(true,true);");
  await waitFor('!completionFixture.dot(completionFixture.ids.done)');
  await check('ReturningFocusAcknowledgesVisibleConversationOnly', "completionFixture.reads.length===2&&completionFixture.reads[1].runId==='done-unfocused'&&!!completionFixture.dot(completionFixture.ids.failed)");

  await act("completionFixture.view(false);completionFixture.complete(completionFixture.ids.done,'done-held');completionFixture.holdRead=true;completionFixture.view(true);");
  await waitFor('completionFixture.pendingReads.length===1');
  await act("completionFixture.view(false);completionFixture.complete(completionFixture.ids.done,'done-newer');completionFixture.releaseRead();");
  await waitFor('completionFixture.pendingReads.length===0');
  await check('OlderReadAcknowledgementCannotEraseANewerCompletion', "!!completionFixture.dot(completionFixture.ids.done)&&historyCompletions.get(completionFixture.ids.done).runId==='done-newer'&&completionFixture.items.get(completionFixture.ids.done).runId==='done-newer'");
  await act("historyCompletions.applySnapshot({revision:1,items:[]});");
  await check('StaleSnapshotCannotEraseNewerUnreadState', "historyCompletions.get(completionFixture.ids.done).runId==='done-newer'&&!!completionFixture.dot(completionFixture.ids.done)");
  await act("completionFixture.holdRead=false;completionFixture.view(true);");
  await waitFor('!completionFixture.dot(completionFixture.ids.done)');
  await act("completionFixture.view(false);completionFixture.complete(completionFixture.ids.done,'done-load-1');completionFixture.holdLoad=completionFixture.ids.done;completionFixture.navigation=loadConversation(completionFixture.ids.done,null,{forceReload:true});completionFixture.focused=true;completionFixture.beforeLoadRace=completionFixture.reads.length;");
  await waitFor('completionFixture.pendingLoads.length===1');
  await act("completionFixture.complete(completionFixture.ids.done,'done-load-2');completionFixture.holdLoad=null;completionFixture.releaseLoad();");
  await evaluate('completionFixture.navigation');
  await check('CompletionArrivingDuringHistoryLoadRemainsUnread', "!!completionFixture.dot(completionFixture.ids.done)&&completionFixture.reads.length===completionFixture.beforeLoadRace&&pendingConversationViewReloads.has('chat:'+completionFixture.ids.done)");
  await evaluate('loadConversation(completionFixture.ids.done)');
  await waitFor('!completionFixture.dot(completionFixture.ids.done)');
  await check('NextVisitReloadsAndAcknowledgesTheNewerCompletion', "completionFixture.reads.at(-1).runId==='done-load-2'&&!pendingConversationViewReloads.has('chat:'+completionFixture.ids.done)");
  await act("completionFixture.records.get(completionFixture.ids.done).turns[0].assistant='外部任务已落盘的新结果';completionFixture.holdLoad=completionFixture.ids.done;completionFixture.beforeExternalRead=completionFixture.reads.length;completionFixture.complete(completionFixture.ids.done,'done-external');");
  await waitFor('completionFixture.pendingLoads.length===1');
  await check('ExternalCompletionReloadsMountedConversationBeforeAcknowledgement', "!!completionFixture.dot(completionFixture.ids.done)&&completionFixture.reads.length===completionFixture.beforeExternalRead&&!messagesEl.textContent.includes('外部任务已落盘的新结果')");
  await act("completionFixture.holdLoad=null;completionFixture.releaseLoad();");
  await waitFor('!completionFixture.dot(completionFixture.ids.done)');
  await check('ExternalCompletionIsReadOnlyAfterPersistedNewBodyAppears', "completionFixture.reads.at(-1).runId==='done-external'&&completionFixture.reads.at(-1).text.includes('外部任务已落盘的新结果')");
  await act("completionFixture.view(false);runs.set(completionFixture.ids.done,{convId:completionFixture.ids.done,jobId:'done-local-background',turn:{}});completionFixture.complete(completionFixture.ids.done,'done-local-background');runs.delete(completionFixture.ids.done);window.relayHistoryCompletionView.ready('chat',completionFixture.ids.done);completionFixture.returnHadNoPendingReload=!pendingConversationViewReloads.has('chat:'+completionFixture.ids.done);");
  await evaluate("loadConversation('10000000-0000-4000-8000-000000000099')");
  await act("completionFixture.beforeReturnLoads=completionFixture.loads.filter(id=>id===completionFixture.ids.done).length;completionFixture.focused=true;");
  await evaluate('loadConversation(completionFixture.ids.done)');
  await waitFor('!completionFixture.dot(completionFixture.ids.done)');
  await check('ReturningAfterFailedOtherLoadRefreshesAndReadsMountedUnreadChat', "completionFixture.returnHadNoPendingReload&&completionFixture.loads.filter(id=>id===completionFixture.ids.done).length===completionFixture.beforeReturnLoads+1&&completionFixture.reads.at(-1).runId==='done-local-background'&&currentConv.id===completionFixture.ids.done");
  await act("completionFixture.view(false);completionFixture.complete(completionFixture.ids.done,'done-external-background');completionFixture.beforeDifferentLoad={oldLoads:completionFixture.loads.filter(id=>id===completionFixture.ids.done).length,reads:completionFixture.reads.length};completionFixture.focused=true;");
  await evaluate('loadConversation(completionFixture.ids.current)');
  await settle();
  await check('ExplicitDifferentChatNavigationCannotBeOverriddenByPendingExternalReload', "currentConv.id===completionFixture.ids.current&&activeView==='chat'&&completionFixture.loads.filter(id=>id===completionFixture.ids.done).length===completionFixture.beforeDifferentLoad.oldLoads&&completionFixture.reads.length===completionFixture.beforeDifferentLoad.reads&&!!completionFixture.dot(completionFixture.ids.done)&&historyCompletionExternalReloads.has('chat:'+completionFixture.ids.done)");
  await evaluate('loadCreateConv(completionFixture.ids.create)');
  await waitFor('!completionFixture.dot(completionFixture.ids.create)');
  await check('OpeningCompletedImageConversationClearsOnlyItsDot', "completionFixture.reads.at(-1).id===completionFixture.ids.create&&completionFixture.reads.at(-1).runId==='create-1'&&!!completionFixture.dot(completionFixture.ids.failed)");
  await act("completionFixture.missingRecord=completionFixture.records.get(completionFixture.ids.failed);completionFixture.records.delete(completionFixture.ids.failed);completionFixture.beforeMissingLoad=completionFixture.reads.length;");
  await evaluate('loadConversation(completionFixture.ids.failed)');
  await check('MissingConversationLoadDoesNotAcknowledgeCompletion', "completionFixture.reads.length===completionFixture.beforeMissingLoad&&!!completionFixture.dot(completionFixture.ids.failed)");
  await act("completionFixture.records.set(completionFixture.ids.failed,completionFixture.missingRecord);completionFixture.rejectRead=true;");
  await evaluate('loadConversation(completionFixture.ids.failed)');
  await settle();
  await check('FailedReadAcknowledgementKeepsVisibleUnreadIndicator', "completionFixture.reads.at(-1).id===completionFixture.ids.failed&&!!completionFixture.dot(completionFixture.ids.failed)");
  await act("completionFixture.rejectRead=false;completionFixture.view(false);completionFixture.view(true);");
  await waitFor('!completionFixture.dot(completionFixture.ids.failed)');
  await check('RefocusingRetriesFailedAcknowledgementWithoutHistoryWrites', "completionFixture.reads.at(-1).runId==='failed-1'&&completionFixture.writes.length===0");
  await check('RendererRemainsSandboxedWithoutErrorsOrRealWrites', "typeof require==='undefined'&&typeof process==='undefined'&&uiFixture.errors.length===0&&completionFixture.writes.length===0&&!uiFixture.calls.includes('runClaude')");
  await capture('sidebar-completion-read');
  report.step = 'completed'; save(); clearTimeout(deadline); app.exit(0);
}).catch(async error => {
  report.failures.push(String(error.stack || error)); save(); console.error(error.stack);
  try { if (win&&!win.isDestroyed()) { await capture('failure'); console.error(await evaluate('JSON.stringify(uiFixture.errors)')); } } catch (_) {}
  clearTimeout(deadline); app.exit(1);
});
