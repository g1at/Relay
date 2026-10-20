'use strict';
// Real renderer, real recovery reducer and checkpoint format; synthetic input only.
// This application has its own temporary profile and blocks all HTTP(S) requests.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { recoverConversationTurn } = require('../src/main/history/conversation-turn-recovery');
const { TaskProgressStore } = require('../src/main/tasks/task-progress-store');
const continuity = require('../renderer/task-continuity');
const root = path.resolve(__dirname, '..');
const rendererRoot = process.env.RELAY_SMOKE_RENDERER_ROOT ? path.resolve(process.env.RELAY_SMOKE_RENDERER_ROOT) : root;
const out = process.env.RELAY_SMOKE_OUTPUT ? path.resolve(process.env.RELAY_SMOKE_OUTPUT)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'relay-turn-recovery-smoke-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'relay-turn-recovery-profile-')));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
let win, step = 'starting';
const checks = {}, failures = [], diagnostics = [];
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, failures, diagnostics }, null, 2));
const deadline = setTimeout(() => { failures.push('timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
async function atStep(name, operation, timeoutMs = 15000) {
  step = name; save(); console.log('Step: ' + name);
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('Timed out at ' + name)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(code) {
  step = 'waiting: ' + code; save();
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+10000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`);
}
async function check(name, code) {
  step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]);
  if (!checks[name]) throw Error(name);
}
async function capture(name) {
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

// Synthetic API owns only these records. Neither the installed app nor any real
// history directory participates; the main-process reducer produced `recovered`.
function seed(data) {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  let record = clone(data.initial);
  const f = window.turnRecoveryFixture = { ...data, recoveries: 0, completions: 0, fullSaves: 0, launches: 0,
    read: () => clone(record), task: clone(data.task) };
  window.api = new Proxy(base, { get(target, key) {
    if (key === 'runClaude') return async () => { f.launches++; throw Error('Recovery cannot launch a model'); };
    if (key === 'history') return new Proxy(target.history, { get(original, method) {
      if (method === 'list') return async () => [clone(record)];
      if (method === 'load') return async id => id === record.id ? clone(record) : null;
      if (method === 'save') return async () => { f.fullSaves++; throw Error('Recovery must not save a whole stale conversation'); };
      if (method === 'recoverTurn') return async (id, runId) => {
        if (id !== record.id || runId !== data.runId) return { ok: false, error: 'Unexpected synthetic recovery identity' };
        f.recoveries++;
        record = clone(data.recovered);
        return { ok: true, conversation: clone(record) };
      };
      if (method === 'completeTurn') return async (id, runId, ts, payload) => {
        const index = record.turns.findIndex(turn => turn.runId === runId && turn.ts === ts);
        if (id !== record.id || index !== 6) return { ok: false, error: 'Unexpected synthetic completion identity' };
        f.completions++;
        Object.assign(record.turns[index], clone(payload.turn));
        if (payload.session) Object.assign(record, clone(payload.session));
        record.updatedAt = new Date().toISOString();
        f.task.state = 'succeeded'; f.task.endedAt = record.turns[index].assistantTs;
        return { ok: true, id, updatedAt: record.updatedAt, conversation: clone(record) };
      };
      return original[method];
    } });
    if (key === 'tasks') return new Proxy(target.tasks, { get(original, method) {
      if (method === 'snapshot') return async () => ({ ok: true, epoch: data.epoch, items: [clone(f.task)] });
      if (method === 'progress') return async runId => ({ ok: true, progress: runId === data.runId ? clone(data.progress) : null });
      if (method === 'replayStream') return async () => ({ ok: true, events: [], hasMore: false });
      return original[method];
    } });
    return target[key];
  } });
}

app.whenReady().then(async () => {
  step = 'app-ready'; save();
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const runId = '77777777-7777-4777-8777-777777777777', epoch = 'synthetic-recovery-epoch';
  const oldTs = '2026-09-28T07:04:42.155Z', oldEnd = '2026-09-28T09:01:28.211Z';
  const newTs = '2026-09-28T09:10:12.672Z', newStart = Date.parse(newTs), newEnd = newStart + 100000;
  const oldTurn = { runId: '66666666-6666-4666-8666-666666666666', ts: oldTs,
    user: '15:04 的合成原始请求', assistant: '15:04 请求的完整回复仍然在这里。',
    assistantTs: oldEnd, status: 'complete', files: [],
    activity: { phase: 'complete', startedAt: Date.parse(oldTs), endedAt: Date.parse(oldEnd),
      taskStartedAt: Date.parse(oldTs), taskFinishedAt: Date.parse(oldEnd), taskDurationMs: Date.parse(oldEnd) - Date.parse(oldTs),
      items: [{ id: 'old-process', type: 'narration', title: '此前任务过程', result: '第六轮已完成', status: 'success' }] } };
  const initial = { id: 'synthetic-turn-recovery', title: '消息与执行任务身份恢复', titleGenerated: true,
    kind: 'chat', mode: 'plain', model: 'opus', sessionModel: 'opus', sessionProviderId: 'fixture',
    sessionProviderRevision: 1, sessionRouteTier: 'opus', sessionAgentEnvironment: 'native',
    createdAt: oldTs, updatedAt: oldEnd,
    turns: [...Array.from({ length: 5 }, (_, i) => ({ runId: 'earlier-' + i, user: '合成历史 ' + (i + 1),
      assistant: '历史回答 ' + (i + 1), status: 'complete', ts: '2026-09-27T01:00:00.000Z' })), oldTurn] };
  const taskRun = continuity.begin({ runId, startedAt: newStart });
  const recoveryTurn = { runId, ts: newTs, user: '17:10 的独立合成请求\n保留原文第二行', files: [], taskRun };
  const task = { runId, kind: 'chat', state: 'running', createdAt: newTs, startedAt: newTs,
    source: { type: 'conversation', conversationId: initial.id, mode: 'plain' },
    metadata: { turnIndex: 6, turnTs: newTs, recoveryTurn, taskRun }, execution: { appInstanceId: epoch } };
  const recovered = recoverConversationTurn({ conversation: initial, run: task });
  assert.equal(recovered.ok, true); assert.equal(recovered.conversation.turns.length, 7);
  assert.equal(initial.turns.length, 6); assert.deepEqual(recovered.conversation.turns[5], oldTurn);
  checks.RecoveryReducerPreservedAllSixExistingTurns = true;
  const frame = { type: 'assistant', uuid: 'synthetic-running-message', jobId: runId,
    relay_task_id: taskRun.taskId, relay_task_started_at: newStart,
    relay_task_segment_started_at: newStart, relay_task_elapsed_before_ms: 0,
    message: { id: 'synthetic-running-message', content: [{ type: 'text', text: '第七轮合成进度：正在核对新请求。' },
      { type: 'tool_use', id: 'synthetic-task-create', name: 'TaskCreate', input: { subject: '核对第七轮合成请求' } }] } };
  const store = new TaskProgressStore({ rootDir: path.join(out, 'synthetic-checkpoint'), flushIntervalMs: 60000 });
  store.observe([{ type: 'claude.event', epoch, runId, seq: 1, emittedAt: newTs, payload: { event: frame } }]);
  await atStep('write-synthetic-checkpoint', () => store.close());
  const reader = new TaskProgressStore({ rootDir: path.join(out, 'synthetic-checkpoint') });
  const progress = await atStep('read-synthetic-checkpoint', () => reader.load(runId)); await reader.close();
  assert.equal(progress.runId, runId);
  const data = { initial, recovered: recovered.conversation, task, runId, epoch, progress, oldTurn, newTs,
    newEnd: new Date(newEnd).toISOString(), finalAnswer: '第七轮独立请求已经完成，回复没有覆盖第六轮。' };
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js']
    .map(file => fs.readFileSync(path.join(root, 'test', file), 'utf8')).join('\n')
    + `\n(${seed.toString()})(${JSON.stringify(data).replace(/</g, '\\u003c')});localStorage.clear();`;
  const page = path.join(out, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(rendererRoot, 'renderer/index.html'), 'utf8')
    .replace('<head>', '<head><base href="' + pathToFileURL(path.join(rendererRoot, 'renderer') + path.sep).href + '"><script>' + fixture + '</script>'));
  win = new BrowserWindow({ width: 1220, height: 920, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  for (const event of ['did-start-loading', 'dom-ready', 'did-finish-load', 'did-stop-loading']) {
    win.webContents.on(event, () => { diagnostics.push(event); save(); });
  }
  win.webContents.on('did-fail-load', (_event, code, description) => {
    diagnostics.push(`did-fail-load: ${code} ${description}`); save();
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) { diagnostics.push('renderer: ' + String(message).slice(0, 1000)); save(); }
  });
  // Start the renderer target before issuing CDP commands. On Windows a command
  // sent against a new, unnavigated WebContents can wait until the target exists.
  await atStep('load-isolated-renderer', () => win.loadFile(page));
  win.showInactive(); win.webContents.debugger.attach('1.3');
  await atStep('set-fixture-timezone', () => win.webContents.debugger.sendCommand(
    'Emulation.setTimezoneOverride', { timezoneId: 'Asia/Singapore' }), 5000);
  await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle&&runs.size===1');
  await evaluate('loadConversation(turnRecoveryFixture.initial.id,null,{forceReload:true})');
  await check('MissingSeventhTurnRecoveredExactlyOnce', 'turnRecoveryFixture.recoveries===1&&currentConv.turns.length===7&&runs.get(currentConv.id).turnIndex===6&&runs.get(currentConv.id).jobId===turnRecoveryFixture.runId');
  await check('OriginalInputAndSendTimeRetained', 'currentConv.turns[6].user===turnRecoveryFixture.task.metadata.recoveryTurn.user&&currentConv.turns[6].ts===turnRecoveryFixture.newTs&&runs.get(currentConv.id).turn.ts===turnRecoveryFixture.newTs');
  await check('PriorReplyIsVisibleBeforeNewUserMessage', '(()=>{const old=document.querySelector(".message.assistant[data-turn=\\\"5\\\"]"),next=document.querySelector(".message.user[data-turn=\\\"6\\\"]");return !!old&&!!next&&old.textContent.includes(turnRecoveryFixture.oldTurn.assistant)&&!!(old.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING)})()');
  await check('UserMessagesShowIndependent1504And1710Times', 'document.querySelector(".message.user[data-turn=\\\"5\\\"] time").textContent.includes("15:04")&&document.querySelector(".message.user[data-turn=\\\"6\\\"] time").textContent.includes("17:10")');
  await check('OldAnswerKeepsItsActual1701Timestamp', 'document.querySelector(".message.assistant[data-turn=\\\"5\\\"] time").dateTime===turnRecoveryFixture.oldTurn.assistantTs&&document.querySelector(".message.assistant[data-turn=\\\"5\\\"] time").textContent.includes("17:01")');
  await check('OnlySeventhTurnIsRunning', '(()=>{const streams=[...document.querySelectorAll(".process-stream")];return streams.length===2&&streams[0].querySelector(".process-summary-title").textContent==="已结束"&&streams[1].querySelector(".process-summary-title").textContent==="正在处理"&&runs.get(currentConv.id).activityState.taskStartedAt===Date.parse(turnRecoveryFixture.newTs)})()');
  await act('document.querySelector(".message.user[data-turn=\\\"5\\\"]").scrollIntoView({block:"start"});');
  await capture('recovered-running');
  await act(`uiFixture.emit('onEvent',{jobId:turnRecoveryFixture.runId,type:'assistant',message:{id:'synthetic-final',content:[{type:'text',text:turnRecoveryFixture.finalAnswer}]}});uiFixture.emit('onEvent',{jobId:turnRecoveryFixture.runId,type:'job-done',exitCode:0,relay_task_finished_at:Date.parse(turnRecoveryFixture.newEnd),relay_task_duration_ms:100000,finalResult:{type:'result',subtype:'success',result:turnRecoveryFixture.finalAnswer}});`);
  await waitFor('runs.size===0&&turnRecoveryFixture.completions===1');
  await evaluate('loadConversation(turnRecoveryFixture.initial.id,null,{forceReload:true})');
  await check('FinalResultAndTimestampBelongOnlyToSeventhTurn', 'currentConv.turns[6].assistant===turnRecoveryFixture.finalAnswer&&currentConv.turns[6].assistantTs===turnRecoveryFixture.newEnd&&document.querySelector(".message.assistant[data-turn=\\\"6\\\"] time").dateTime===turnRecoveryFixture.newEnd&&document.querySelector(".message.assistant[data-turn=\\\"6\\\"]").textContent.includes(turnRecoveryFixture.finalAnswer)');
  await check('SixthTurnWasNeverOverwritten', 'JSON.stringify(currentConv.turns[5])===JSON.stringify(turnRecoveryFixture.oldTurn)&&document.querySelector(".message.assistant[data-turn=\\\"5\\\"]").textContent.includes(turnRecoveryFixture.oldTurn.assistant)');
  await evaluate('restoreActiveRunsFromLedger()');
  await check('RepeatedRecoveryDoesNotDuplicateTurnsOrAnswers', 'turnRecoveryFixture.recoveries===1&&turnRecoveryFixture.completions===1&&turnRecoveryFixture.read().turns.length===7&&runs.size===0');
  await check('NoModelLaunchFullHistoryWriteOrRendererError', 'turnRecoveryFixture.launches===0&&turnRecoveryFixture.fullSaves===0&&uiFixture.errors.length===0&&typeof require==="undefined"');
  await act('document.querySelector(".message.user[data-turn=\\\"5\\\"]").scrollIntoView({block:"start"});');
  await capture('recovered-complete');
  step = 'completed'; save(); console.log('Artifacts: ' + out); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack || error)); console.error(error);
  if (win && !win.isDestroyed()) {
    try {
      const state = await evaluate(`({
        providerRoutingLoaded: typeof providerRoutingLoaded === 'undefined' ? null : providerRoutingLoaded,
        restoringTaskLifecycle: typeof restoringTaskLifecycle === 'undefined' ? null : restoringTaskLifecycle,
        runsSize: typeof runs === 'undefined' ? null : runs.size,
        assistantOutputLoaded: !!window.RelayAssistantOutput,
        fixtureErrors: window.uiFixture?.errors || []
      })`);
      diagnostics.push({ pageState: state }); save(); console.error('Page state:', JSON.stringify(state));
    } catch (inspectionError) { diagnostics.push('page-state-unavailable: ' + String(inspectionError)); }
    try { await capture('failure'); } catch (_) {}
  }
  save(); clearTimeout(deadline); app.exit(1);
});
