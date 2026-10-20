'use strict';
// Real sandboxed renderer; deletion APIs and history are entirely in memory.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp/history-delete-running-2026-10-16/ui');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
const report = { runtime: process.versions.electron, platform: process.platform, checks: {}, failures: [], step: 'starting' };
let win;
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { report.failures.push('Timeout: ' + report.step); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;function check(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(check,20)}check()})`);
}
async function check(name, code) {
  report.step = name; report.checks[name] = !!await evaluate(code); save();
  if (!report.checks[name]) throw Error(name);
}
async function capture(name) {
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function seed() {
  const base = window.api, clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const ids = { chat: '10000000-0000-4000-8000-000000000011', create: '10000000-0000-4000-8000-000000000012', empty: '10000000-0000-4000-8000-000000000013' };
  const records = new Map([
    [ids.chat, { id: ids.chat, title: '临时目录删除验收对话', kind: 'chat', mode: 'plain', model: 'opus', updatedAt: '2026-10-11T00:00:00.000Z',
      turns: [{ user: '合成问题', assistant: '合成回答', ts: '2026-10-11T00:00:00.000Z' }] }],
    [ids.create, { id: ids.create, title: '临时目录删除验收创作', kind: 'create', updatedAt: '2026-10-10T00:00:00.000Z',
      turns: [{ prompt: '合成创作描述', model: 'fixture', size: '1024x1024', resultPaths: [] }] }],
    [ids.empty, { id: ids.empty, title: '无临时文件的验收对话', kind: 'chat', mode: 'plain', model: 'opus', updatedAt: '2026-10-09T00:00:00.000Z', turns: [] }],
  ]);
  const state = window.deleteFixture = { ids, records, calls: [], loadCalls: 0, listCalls: 0, pending: null, writes: [], pauseCalls: [], taskListeners: new Set(), taskSnapshots: 0,
    tasks: [{ runId: 'snapshot-mini', state: 'running', kind: 'chat', source: { type: 'mini', conversationId: ids.chat } }],
    emitTask(task) { for (const listener of state.taskListeners) listener({ payload: { run: clone(task) } }); },
    finish(result) {
      const pending = state.pending; state.pending = null;
      if (!pending) throw Error('No synthetic pending deletion');
      if (result.ok) records.delete(pending.id);
      pending.resolve(result);
    },
    reject(message) { const pending = state.pending; state.pending = null; pending.reject(Error(message)); },
  };
  const history = new Proxy(base.history, { get(target, key) {
    if (key === 'list') return async () => { state.listCalls++; return clone([...records.values()]); };
    if (key === 'load') return async id => { state.loadCalls++; return clone(records.get(id) || null); };
    if (key === 'save') return async record => { if (state.holdSave) return new Promise((resolve, reject) => { state.pendingSave = { resolve, reject }; }); state.writes.push(clone(record)); records.set(record.id, clone(record)); return clone(record); };
    if (key === 'delete') return id => { state.calls.push(id); return new Promise((resolve, reject) => { state.pending = { id, resolve, reject }; }); };
    return target[key];
  } });
  const tasks = new Proxy(base.tasks || {}, { get(target, key) {
    if (key === 'snapshot') return async () => { state.taskSnapshots++; return { ok: true, epoch: 'fixture', items: clone(state.tasks) }; };
    if (key === 'onEvent') return callback => { state.taskListeners.add(callback); return () => state.taskListeners.delete(callback); };
    if (key === 'replayStream') return async () => ({ ok: true, events: [], hasMore: false });
    return target[key];
  } });
  window.api = new Proxy(base, { get(target, key) {
    if (key === 'pauseClaude') return async id => { state.pauseCalls.push(id); if (state.holdPause) return new Promise(resolve => { state.finishPause = resolve; }); return { settled: true, paused: true }; };
    return key === 'history' ? history : key === 'tasks' ? tasks : target[key];
  } });
}
async function openDelete(kind) {
  await act(`document.querySelector('.history-item[data-id="'+deleteFixture.ids.${kind}+'"] .hi-del').click();`);
  await waitFor("!!document.querySelector('.confirm-overlay')");
}
async function confirm() {
  await act("document.querySelector('.confirm-overlay .confirm-btn.danger').click();");
  await waitFor('!!deleteFixture.pending');
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(root, 'test', name), 'utf8')).join('\n') + `\n(${seed.toString()})();localStorage.clear();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}</script>`);
  const page = path.join(out, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1220, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page); await waitFor('providerRoutingLoaded&&!restoringActiveRuns&&!restoringTaskLifecycle&&deleteFixture.taskSnapshots>=2');
  await evaluate('loadConversation(deleteFixture.ids.chat)');
  await check('initialLedgerSnapshotDisablesMiniConversationWithoutRestoringItAsChat', "historyActiveTaskOwners.get('snapshot-mini')===deleteFixture.ids.chat&&!runs.has(deleteFixture.ids.chat)&&document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled");
  await act("deleteFixture.beforeEvents={list:deleteFixture.listCalls,load:deleteFixture.loadCalls};deleteFixture.emitTask({runId:'scheduled-live',kind:'chat',state:'starting',source:{type:'scheduled',conversationId:deleteFixture.ids.chat}});deleteFixture.emitTask({runId:'snapshot-mini',state:'succeeded'});");
  await check('terminalMiniDoesNotUnlockAnotherScheduledRunInSameConversation', "historyActiveTaskOwners.size===1&&historyActiveTasksByConversation.get(deleteFixture.ids.chat).size===1&&document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled");
  await act("deleteFixture.emitTask({runId:'scheduled-live',state:'stopping',source:{type:'scheduled',conversationId:deleteFixture.ids.chat}});");
  await check('stoppingLedgerRunRemainsUnavailableForDeletion', "document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled");
  await act("deleteFixture.emitTask({runId:'scheduled-live',state:'canceled'});deleteFixture.emitTask({runId:'unowned-mini',state:'running',source:{type:'mini'}});");
  await check('lastTerminalEventUnlocksOnlyOwnedConversationWithoutHistoryReadsOrRefresh', "historyActiveTaskOwners.size===0&&historyActiveTasksByConversation.size===0&&!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled&&deleteFixture.listCalls===deleteFixture.beforeEvents.list&&deleteFixture.loadCalls===deleteFixture.beforeEvents.load");
  await act("deleteFixture.holdSave=true;deleteFixture.sendPromise=send({explicit:true,prompt:'synthetic pending write',files:[],skill:null});");
  await waitFor('!!deleteFixture.pendingSave');
  await check('actualSendImmediatelyDisablesVisibleDeleteDuringInitialSave', "pendingConversationSends.has(deleteFixture.ids.chat)&&document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled&&deleteFixture.listCalls===deleteFixture.beforeEvents.list");
  await act("deleteFixture.pendingSave.reject(Error('synthetic initial save rejection'));");
  await evaluate('deleteFixture.sendPromise');
  await act("deleteFixture.holdSave=false;");
  await check('actualRejectedSendImmediatelyReenablesOnlyThatDeleteButton', "!pendingConversationSends.has(deleteFixture.ids.chat)&&!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled&&deleteFixture.listCalls===deleteFixture.beforeEvents.list");
  await act("deleteFixture.holdPause=true;runs.set(deleteFixture.ids.chat,{convId:deleteFixture.ids.chat,jobId:'pause-closing',turn:{}});deleteFixture.emitTask({runId:'pause-closing',state:'running',source:{type:'chat',conversationId:deleteFixture.ids.chat}});deleteFixture.pausePromise=pauseCurrent();");
  await waitFor('typeof deleteFixture.finishPause==="function"');
  await act("runs.delete(deleteFixture.ids.chat);deleteFixture.emitTask({runId:'pause-closing',state:'canceled'});");
  await check('terminalTaskCannotUnlockDeleteUntilActualPauseRequestReturns', "conversationControls.has(deleteFixture.ids.chat)&&historyActiveTaskOwners.size===0&&!runs.has(deleteFixture.ids.chat)&&document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled");
  await act("deleteFixture.finishPause({settled:true,paused:true});");
  await evaluate('deleteFixture.pausePromise');
  await check('completedPauseRequestLocallyRestoresDeleteAvailability', "!conversationControls.has(deleteFixture.ids.chat)&&!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled");
  await act("deleteFixture.holdPause=false;deleteFixture.pauseCalls.length=0;");
  await act("$('input').value='未发送的草稿';captureComposerDraft();supplementDrafts.set(deleteFixture.ids.chat,{prompt:'失败后仍需保留的补充',files:[]});");
  await waitFor("!!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del')");
  await act("runs.set(deleteFixture.ids.chat,{convId:deleteFixture.ids.chat,jobId:'synthetic-running-chat',turn:{}});cvJobs.set(deleteFixture.ids.create,{runId:'synthetic-running-create'});pendingConversationSends.add(deleteFixture.ids.empty);");
  await evaluate('refreshHistoryList()');
  await check('runningChatImageAndPendingSendDisableOnlyTheirDeleteButtons', "Object.values(deleteFixture.ids).every(id=>{const row=document.querySelector('.history-item[data-id=\"'+id+'\"]'),button=row.querySelector('.hi-del');return button.disabled&&button.title.includes('等待完成或手动暂停')&&getComputedStyle(button).display!=='none'&&Number(getComputedStyle(button).opacity)<1&&!!row.querySelector('.hi-spinner')&&[...row.querySelectorAll('button:not(.hi-del)')].every(item=>!item.disabled)})");
  await act("document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').click();document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.create+'\"] .hi-del').click();");
  await check('disabledDeleteNeverConfirmsDeletesOrPausesARunningTask', "!document.querySelector('.confirm-overlay')&&deleteFixture.calls.length===0&&deleteFixture.pauseCalls.length===0&&runs.has(deleteFixture.ids.chat)&&cvJobs.has(deleteFixture.ids.create)");
  await act("document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').dispatchEvent(new MouseEvent('click',{bubbles:true}));");
  await check('delegatedSyntheticClickCannotBypassRunningGuard', "!document.querySelector('.confirm-overlay')&&deleteFixture.calls.length===0&&deleteFixture.pauseCalls.length===0&&$('appToast').textContent===HISTORY_DELETE_RUNNING_NOTICE");
  await evaluate("RelaySidebarHistory.reconcile(historyEl,[...deleteFixture.records.values()].map(item=>({...item,projectId:'delete-project'})),{buildRow:buildHistoryRow,updateRow:updateHistoryRow,projects:[{id:'delete-project',name:'隔离删除测试项目'}],isRunning:isConvRunning})");
  await check('projectHistoryRowsShareTheRunningDeleteGuard', "Object.values(deleteFixture.ids).every(id=>{const row=document.querySelector('.history-item[data-id=\"'+id+'\"]');return !!row.closest('[data-history-group=project-delete-project]')&&row.querySelector('.hi-del').disabled})");
  await act("runs.delete(deleteFixture.ids.chat);cvJobs.delete(deleteFixture.ids.create);pendingConversationSends.delete(deleteFixture.ids.empty);deleteFixture.records.get(deleteFixture.ids.chat).sessionId='warm-idle-session';");
  await evaluate('refreshHistoryList()');
  await check('finishedOrPausedTasksAndIdleWarmSessionsCanBeDeleted', "Object.values(deleteFixture.ids).every(id=>!document.querySelector('.history-item[data-id=\"'+id+'\"] .hi-del').disabled)&&deleteFixture.pauseCalls.length===0");
  await openDelete('chat');
  await act("runs.set(deleteFixture.ids.chat,{convId:deleteFixture.ids.chat,jobId:'started-during-confirmation',turn:{}});document.querySelector('.confirm-overlay .confirm-btn.danger').click();");
  await waitFor("!document.querySelector('.confirm-overlay')");
  await check('taskStartingWhileConfirmationIsOpenPreventsDeletion', "deleteFixture.calls.length===0&&deleteFixture.pauseCalls.length===0&&deleteFixture.records.has(deleteFixture.ids.chat)&&document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled&&$('appToast').textContent===HISTORY_DELETE_RUNNING_NOTICE");
  await act("runs.delete(deleteFixture.ids.chat);");
  await evaluate('refreshHistoryList()');
  await openDelete('chat');
  await check('confirmationDeletesAllScratchContentsAndKeepsExternalDeliverables', "document.querySelector('.confirm-message').textContent.includes('将永久删除')&&document.querySelector('.confirm-message').textContent.includes('专属临时目录中的全部文件')&&!document.querySelector('.confirm-message').textContent.includes('任务会先停止')&&document.querySelector('.confirm-message').textContent.includes('项目文件和临时目录之外的交付文件会保留')&&document.querySelector('.confirm-message').textContent.includes('由你手动清理')&&!document.querySelector('.confirm-message').textContent.includes('该会话生成的过程文件和交付文件')&&document.activeElement.classList.contains('cancel')");
  await capture('confirmation');
  await act("document.querySelector('.confirm-btn.cancel').click();");
  await check('cancelDoesNotCallDeletionOrDiscardDraft', "deleteFixture.calls.length===0&&currentConv.id===deleteFixture.ids.chat&&$('input').value==='未发送的草稿'");
  await openDelete('chat'); await confirm();
  await check('pendingDeletionRetainsHistoryConversationAndBothDrafts', "currentConv.id===deleteFixture.ids.chat&&deleteFixture.records.has(deleteFixture.ids.chat)&&!!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"]')&&$('input').value==='未发送的草稿'&&composerDrafts.get(deleteFixture.ids.chat).prompt==='未发送的草稿'&&supplementDrafts.get(deleteFixture.ids.chat).prompt==='失败后仍需保留的补充'");
  await check('pendingDeletionDisablesButtonAndSuppressesSecondRequest', "(()=>{const button=document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del'),count=deleteFixture.calls.length;button.click();return button.disabled&&deleteFixture.calls.length===count&&!document.querySelector('.confirm-overlay');})()");
  await check('pendingDeletionShowsVisibleBusyStatusAndDisablesOnlyTargetRow', "(()=>{const row=document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"]');return row.getAttribute('aria-busy')==='true'&&row.classList.contains('deleting')&&row.querySelector('.hi-delete-status').textContent==='正在删除…'&&getComputedStyle(row.querySelector('.hi-delete-status')).display!=='none'&&[...row.querySelectorAll('button')].every(button=>button.disabled)&&[...document.querySelectorAll('.history-item[data-id=\"'+deleteFixture.ids.create+'\"] button')].every(button=>!button.disabled);})()");
  await evaluate('refreshHistoryList()');
  await check('pendingDeletionSurvivesHistoryRefreshAndPreventsRowNavigation', "(()=>{const row=document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"]'),before=deleteFixture.loadCalls;row.dispatchEvent(new MouseEvent('click',{bubbles:true}));return row.getAttribute('aria-busy')==='true'&&row.querySelector('.hi-del').disabled&&deleteFixture.loadCalls===before&&deleteFixture.calls.length===1;})()");
  await capture('pending-delete');
  await act("deleteFixture.finish({ok:false,error:'合成临时目录仍被占用'});");
  await waitFor("$('appToast')?.textContent==='合成临时目录仍被占用'");
  await check('structuredFailurePreservesConversationDraftsAndShowsError', "currentConv.id===deleteFixture.ids.chat&&composerDrafts.has(deleteFixture.ids.chat)&&supplementDrafts.has(deleteFixture.ids.chat)&&$('input').value==='未发送的草稿'&&!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"] .hi-del').disabled&&$('appToast').classList.contains('show')");
  await check('failureRestoresRowControlsAndClearsBusyStatus', "(()=>{const row=document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"]');return !row.hasAttribute('aria-busy')&&!row.classList.contains('deleting')&&!row.querySelector('.hi-delete-status')&&[...row.querySelectorAll('button')].every(button=>!button.disabled)&&!pendingHistoryDeletions.has(deleteFixture.ids.chat);})()");
  await capture('failed-delete-preserves-draft');
  await openDelete('chat'); await confirm(); await act("deleteFixture.reject('合成删除请求中断');");
  await waitFor("$('appToast')?.textContent==='合成删除请求中断'");
  await check('rejectedRequestAlsoKeepsCurrentConversationAndDrafts', "currentConv.id===deleteFixture.ids.chat&&composerDrafts.has(deleteFixture.ids.chat)&&supplementDrafts.has(deleteFixture.ids.chat)&&$('input').value==='未发送的草稿'&&deleteFixture.records.has(deleteFixture.ids.chat)");
  await openDelete('chat'); await confirm();
  await act("deleteFixture.finish({ok:false,code:'CONVERSATION_RUNNING',error:'synthetic backend running conflict'});");
  await waitFor("$('appToast')?.textContent===HISTORY_DELETE_RUNNING_NOTICE");
  await check('backendRunningConflictPreservesHistoryDraftsAndNeverPauses', "currentConv.id===deleteFixture.ids.chat&&deleteFixture.records.has(deleteFixture.ids.chat)&&composerDrafts.has(deleteFixture.ids.chat)&&supplementDrafts.has(deleteFixture.ids.chat)&&deleteFixture.pauseCalls.length===0&&!pendingHistoryDeletions.has(deleteFixture.ids.chat)");
  await openDelete('chat'); await confirm();
  await act("deleteFixture.finish({ok:true,deleted:true,fileCleanup:{removedPaths:['C:/synthetic/scratch/conversation/work/owned-process.py','C:/synthetic/scratch/conversation/report.pdf'],retainedFiles:[]}});");
  await waitFor("!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.chat+'\"]')&&currentConv===null");
  await check('successAloneRemovesHistoryDraftsAndStartsEmptyConversation', "!deleteFixture.records.has(deleteFixture.ids.chat)&&!composerDrafts.has(deleteFixture.ids.chat)&&!supplementDrafts.has(deleteFixture.ids.chat)&&$('input').value===''&&currentConv===null&&deleteFixture.records.has(deleteFixture.ids.create)");
  await check('scratchDeletionSuccessUsesActualCleanupResult', "$('appToast').textContent==='会话及其临时文件已删除。'");
  await evaluate('loadCreateConv(deleteFixture.ids.create)');
  await openDelete('create'); await confirm();
  await check('creationHistoryWaitsForDeletionResponseBeforeResetting', "currentCreateConv.id===deleteFixture.ids.create&&currentCreateConv.turns.length===1&&!!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.create+'\"]')");
  await act("deleteFixture.finish({ok:true,deleted:true,fileCleanup:{removedPaths:[],retainedFiles:[{path:'C:/synthetic/scratch/conversation',reason:'unverified-owner'}]},cleanupWarning:'会话已删除；临时目录无法确认专属归属，已保留。'});");
  await waitFor("!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.create+'\"]')");
  await check('scratchCleanupWarningTakesPriorityOverGenericSuccess', "$('appToast').textContent==='会话已删除；临时目录无法确认专属归属，已保留。'&&!$('appToast').textContent.includes('历史过大')");
  await check('creationSuccessResetsOnlyAfterSuccessfulResponse', "currentCreateConv.id===null&&currentCreateConv.turns.length===0&&!deleteFixture.records.has(deleteFixture.ids.create)");
  await openDelete('empty'); await confirm();
  await act("deleteFixture.finish({ok:true,deleted:true,fileCleanup:{removedPaths:[],retainedFiles:[]}});");
  await waitFor("!document.querySelector('.history-item[data-id=\"'+deleteFixture.ids.empty+'\"]')");
  await check('noScratchFilesSuccessDoesNotClaimFileDeletion', "$('appToast').textContent==='会话已删除。'&&!deleteFixture.records.has(deleteFixture.ids.empty)");
  await check('rendererStayedSandboxedWithoutUncaughtErrors', "typeof require==='undefined'&&typeof process==='undefined'&&uiFixture.errors.length===0&&deleteFixture.writes.length===0");
  await capture('completed'); report.step = 'completed'; save(); clearTimeout(deadline); app.exit(0);
}).catch(async error => {
  report.failures.push(String(error.stack || error)); save(); console.error(error.stack);
  try { if (win && !win.isDestroyed()) { await capture('failure'); console.error(await evaluate('JSON.stringify(uiFixture.errors)')); } } catch (_) {}
  clearTimeout(deadline); app.exit(1);
});
