'use strict';
// Real renderer and disk checkpoint; all history, commands and model events are
// synthetic. No SDK import, user profile access, network, or actual tool calls.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { TaskProgressStore } = require('../task-progress-store');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp/crash-progress-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
let win, step = 'starting';
const checks = {}, failures = [];
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, failures }, null, 2));
const deadline = setTimeout(() => { failures.push('timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+10000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`);
}
async function check(name, code) {
  step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]);
  if (!checks[name]) throw Error(name);
}
async function capture(name) {
  await delay(150);
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

// This is injected before actual app.js. Its methods implement only in-memory
// APIs, including explicit old-process replay and an already persisted failure.
function seed(data) {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  const records = new Map((data.history || []).map(value => [value.id, clone(value)]));
  const f = window.crashFixture = { ...data, saves: 0, launches: 0, snapshots: 0, progressCalls: [], replayCalls: [],
    read: id => clone(records.get(id) || null),
  };
  window.api = new Proxy(base, { get(target, key) {
    if (key === 'runClaude') return async (...args) => { f.launches++; return target.runClaude(...args); };
    if (key === 'history') return new Proxy(target.history, { get(original, method) {
      if (method === 'list') return async () => clone([...records.values()]);
      if (method === 'load') return async id => clone(records.get(id) || null);
      if (method === 'save') return async value => {
        f.saves++;
        const next = clone({ ...value, id: value.id || 'crash-conversation', updatedAt: new Date().toISOString() });
        records.set(next.id, next); return clone(next);
      };
      return original[method];
    } });
    if (key === 'tasks') return new Proxy(target.tasks, { get(original, method) {
      if (method === 'snapshot') return async () => { f.snapshots++; return { ok: true, epoch: 'fixture-new-process', items: clone(data.tasks || []) }; };
      if (method === 'progress') return async runId => {
        f.progressCalls.push(runId); return { ok: true, progress: clone(data.progress?.[runId] || null) };
      };
      if (method === 'replayStream') return async input => {
        f.replayCalls.push(clone(input));
        const events = (data.events || []).filter(event => event.runId === input.runId
          && event.epoch === input.epoch && event.seq > (input.sinceSeq || 0));
        return { ok: true, epoch: input.epoch, events: clone(events), hasMore: false };
      };
      return original[method];
    } });
    return target[key];
  } });
}

async function openRenderer(data, name) {
  if (win && !win.isDestroyed()) win.destroy();
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js']
    .map(file => fs.readFileSync(path.join(root, 'test', file), 'utf8')).join('\n')
    + `\n(${seed.toString()})(${JSON.stringify(data).replace(/</g, '\\u003c')});localStorage.clear();`;
  const page = path.join(out, name + '.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8')
    .replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + '</script>'));
  win = new BrowserWindow({ width: 1220, height: 900, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive();
  await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle');
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  await openRenderer({}, 'live');
  await act(`$('input').value='整理一份合成进度报告';$('btnSend').click();`);
  await waitFor('runs.size===1');
  const live = await evaluate('({conversation:JSON.parse(JSON.stringify(currentConv)),runId:runs.get(currentConv.id).jobId})');
  const runId = live.runId, epoch = 'fixture-old-process';
  const baseTime = Date.parse(live.conversation.turns[0].ts);
  const frames = [
    { type: 'assistant', uuid: 'synthetic-thinking-one', message: { id: 'synthetic-first-message', content: [{ type: 'thinking', thinking: '合成思考：先检查报告结构，再核对保存状态。' }] } },
    { type: 'assistant', uuid: 'synthetic-narration-one', message: { id: 'synthetic-first-message', content: [{ type: 'text', text: '合成进度：正在检查报告结构。' }] } },
    { type: 'assistant', uuid: 'synthetic-tool-call', message: { id: 'synthetic-first-message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'synthetic-read', name: 'Read', input: { file_path: 'C:\\synthetic\\report.md' } }] } },
    { type: 'user', uuid: 'synthetic-tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'synthetic-read', content: '合成工具结果：报告包含标题和进度清单。' }] } },
    { type: 'assistant', uuid: 'synthetic-thinking-two', message: { id: 'synthetic-second-message', content: [{ type: 'thinking', thinking: '合成思考：结构已确认，准备继续整理内容。' }] } },
    { type: 'assistant', uuid: 'synthetic-narration-two', message: { id: 'synthetic-second-message', content: [{ type: 'text', text: '合成进度：检查已完成，后续内容尚未整理。' }] } },
  ];
  const envelopes = frames.map((event, index) => ({ type: 'claude.event', epoch, runId, seq: index + 1,
    emittedAt: new Date(baseTime + index * 1000).toISOString(), payload: { event: { ...event, jobId: runId } } }));
  await act(`for(const envelope of ${JSON.stringify(envelopes)})uiFixture.emit('onEvent',envelope.payload.event);`);
  await waitFor('document.querySelectorAll(".process-item.is-thinking").length===2&&document.querySelectorAll(".process-item.is-narration").length===2');
  await check('LiveRunShowsThinkingToolAndStageText', 'document.querySelectorAll(".process-item.is-tool").length===1&&document.querySelector(".process-summary-title").textContent==="正在处理"');
  await check('LiveStageTextIsNotAFinalAnswer', 'currentConv.turns[0].assistant===""&&document.querySelectorAll(".message.assistant").length===0');
  await capture('live-progress');

  // The persisted checkpoint is deliberately behind the displayed stream.
  // Dispose this store and load from a fresh instance to prove disk persistence.
  const checkpointDir = path.join(out, 'checkpoint-' + runId);
  const writer = new TaskProgressStore({ rootDir: checkpointDir, flushIntervalMs: 60000 });
  writer.observe(envelopes.slice(0, 3)); await writer.close();
  const reader = new TaskProgressStore({ rootDir: checkpointDir });
  const progress = await reader.load(runId); await reader.close();
  assert.equal(progress.seq, 3); assert.equal(progress.output.final, '');
  checks.CheckpointWasReloadedFromDisk = true;
  const error = 'Relay restarted before the task reached a terminal state';
  const later = { user: '另一轮合成任务', assistant: '后续正常任务的最终结论应保持不变。', status: 'complete',
    runId: '22222222-2222-4222-8222-222222222222', ts: new Date(baseTime + 60000).toISOString(), error: null };
  const conversation = live.conversation;
  conversation.title = '意外关闭后的合成进度恢复'; conversation.titleGenerated = true;
  conversation.turns[0] = { ...conversation.turns[0], runId, assistant: '', thinking: null,
    status: 'error', error, output: { status: 'error', messages: [], final: '' },
    activity: { phase: 'error', error, items: [], startedAt: baseTime, endedAt: baseTime + 30000 } };
  conversation.turns.push(later);
  const task = { runId, kind: 'chat', state: 'interrupted', phase: 'terminal',
    source: { type: 'chat', conversationId: conversation.id, mode: 'plain' },
    metadata: { turnIndex: 0, turnTs: conversation.turns[0].ts },
    execution: { appInstanceId: epoch }, result: { error: { code: 'APP_RESTART', message: error } },
    createdAt: conversation.turns[0].ts, startedAt: conversation.turns[0].ts, endedAt: new Date(baseTime + 30000).toISOString() };
  const legacyRunId = '33333333-3333-4333-8333-333333333333';
  const legacy = { ...conversation, id: 'legacy-crash-conversation', title: '旧版本空过程兼容恢复',
    turns: [{ ...conversation.turns[0], runId: legacyRunId }] };
  const legacyTask = { ...task, runId: legacyRunId, source: { ...task.source, conversationId: legacy.id } };
  const legacyEvents = envelopes.map(event => ({ ...event, runId: legacyRunId,
    payload: { event: { ...event.payload.event, jobId: legacyRunId } } }));
  // One repeated UUID after the checkpoint exercises replay overlap deduplication.
  const duplicate = { ...envelopes[1], seq: 7 };
  const restart = { conversationId: conversation.id, runId, legacyId: legacy.id, legacyRunId, error,
    displayedError: 'Relay 在任务完成前关闭，本次任务已中断。',
    expectedLater: later, history: [conversation, legacy], tasks: [task, legacyTask],
    progress: { [runId]: progress }, events: [...envelopes.slice(3), duplicate, ...legacyEvents] };
  await openRenderer(restart, 'restart');
  await waitFor('runs.size===0&&crashFixture.read(crashFixture.conversationId).turns[0].activity.items.length>0&&crashFixture.read(crashFixture.legacyId).turns[0].activity.items.length>0');
  await evaluate('loadConversation(crashFixture.conversationId,null,{forceReload:true})');
  await check('RestartReadsTheOldEpochAndCheckpointCursor', 'crashFixture.progressCalls.includes(crashFixture.runId)&&crashFixture.replayCalls.some(call=>call.runId===crashFixture.runId&&call.epoch==="fixture-old-process"&&call.sinceSeq===3)&&crashFixture.replayCalls.every(call=>call.epoch==="fixture-old-process")');
  await check('CheckpointAndJournalTailRestoreAllProcessItems', 'currentConv.turns[0].activity.items.filter(item=>item.type==="thinking").length===2&&currentConv.turns[0].activity.items.filter(item=>item.type==="tool").length===1&&RelayAssistantOutput.processItems(RelayAssistantOutput.createState(currentConv.turns[0].output)).filter(item=>item.type==="narration").length===2');
  await check('RecoveredToolKeepsItsRealResultReceipt', 'currentConv.turns[0].activity.items.some(item=>item.toolUseId==="synthetic-read"&&item.resultConfirmed&&item.status==="success"&&item.result.includes("合成工具结果"))');
  await check('InterruptedRunNeverBecomesAFinalAnswer', 'currentConv.turns[0].status==="error"&&currentConv.turns[0].error===crashFixture.displayedError&&currentConv.turns[0].output.status==="error"&&!currentConv.turns[0].assistant&&!currentConv.turns[0].output.final&&currentConv.turns[0].output.answers.length===0');
  await check('RecoveryTargetsTheOriginalTurnAndPreservesLaterAnswer', 'JSON.stringify(currentConv.turns[1])===JSON.stringify(crashFixture.expectedLater)&&document.querySelectorAll(".message.assistant").length===1&&document.querySelector(".message.assistant").textContent.includes("后续正常任务的最终结论")');
  await act('for(const button of document.querySelectorAll(".process-stream.is-collapsed .process-summary"))button.click();');
  await delay(220);
  await check('ExpandedRestoredProcessIsVisibleAndIncomplete', 'document.querySelector(".process-summary-title").textContent==="处理未完成"&&document.querySelectorAll(".process-item.is-thinking").length===2&&document.querySelectorAll(".process-item.is-narration").length===2&&document.querySelector(".process-items").getBoundingClientRect().height>50&&!document.querySelector(".process-items").inert');
  await capture('recovered-progress-light');
  await act('document.querySelector(".process-item.is-thinking").click();document.querySelector(".process-item.is-tool").click();');
  await delay(220);
  await check('RecoveredThinkingCanBeOpenedAndRead', 'document.querySelector(".process-item.is-thinking").classList.contains("is-expanded")&&document.querySelector(".process-item.is-thinking .process-output-text").textContent.includes("合成思考：先检查报告结构")&&document.querySelector(".process-item.is-thinking .process-inspector").getBoundingClientRect().height>0&&!document.querySelector(".process-item.is-thinking .process-inspector").inert');
  await check('RecoveredToolArgumentsAndResultCanBeOpened', 'document.querySelector(".process-item.is-tool").classList.contains("is-expanded")&&document.querySelector(".process-item.is-tool .process-inspector").textContent.includes("合成工具结果：报告包含标题和进度清单")&&document.querySelector(".process-item.is-tool .process-inspector").textContent.includes("report.md")&&!document.querySelector(".process-item.is-tool .process-inspector").inert');
  await capture('recovered-details-light');
  await act('crashFixture.saved=JSON.stringify(currentConv.turns);crashFixture.savedAt=currentConv.updatedAt;crashFixture.savesBefore=crashFixture.saves;startNewConv();');
  await evaluate('loadConversation(crashFixture.conversationId,null,{forceReload:true})');
  await check('ReopeningDoesNotDuplicateOrResaveRecoveredItems', 'JSON.stringify(currentConv.turns)===crashFixture.saved&&currentConv.updatedAt===crashFixture.savedAt&&crashFixture.saves===crashFixture.savesBefore&&document.querySelectorAll(".process-item.is-tool").length===1');
  await evaluate('restoreActiveRunsFromLedger()');
  await check('RepeatedStartupRecoveryIsIdempotent', 'crashFixture.saves===crashFixture.savesBefore&&JSON.stringify(crashFixture.read(crashFixture.conversationId).turns)===crashFixture.saved');
  await evaluate('loadConversation(crashFixture.legacyId,null,{forceReload:true})');
  await check('LegacyEmptyRestartErrorRecoversWithoutCheckpoint', 'crashFixture.replayCalls.some(call=>call.runId===crashFixture.legacyRunId&&call.sinceSeq===0)&&currentConv.turns[0].activity.items.filter(item=>item.type==="thinking").length===2&&currentConv.turns[0].error===crashFixture.displayedError&&!currentConv.turns[0].assistant&&document.querySelectorAll(".message.assistant").length===0');
  await act('for(const button of document.querySelectorAll(".process-stream.is-collapsed .process-summary"))button.click();document.documentElement.dataset.theme="dark";');
  win.setSize(940, 820); await delay(180);
  await check('RestoredProgressFitsCompactDarkLayout', 'document.documentElement.scrollWidth<=innerWidth&&document.querySelector(".process-stream").getBoundingClientRect().right<=innerWidth');
  await capture('legacy-recovered-progress-dark');
  await check('RecoveryDoesNotLaunchModelOrExposeNode', 'crashFixture.launches===0&&uiFixture.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack || error)); console.error(error);
  if (win && !win.isDestroyed()) {
    try { console.error(await evaluate('JSON.stringify({errors:uiFixture.errors,calls:crashFixture.replayCalls})')); await capture('failure'); } catch (_) {}
  }
  save(); clearTimeout(deadline); app.exit(1);
});
