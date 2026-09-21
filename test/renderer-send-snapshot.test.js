'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const start = source.indexOf('async function send(options = null)');
const end = source.indexOf('\n// 全局兼容标记', start);
assert.ok(start > 0 && end > start);
const sendSource = source.slice(start, end);
const ID_A = '10000000-0000-4000-8000-000000000001';
const ID_B = '10000000-0000-4000-8000-000000000002';
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function harness() {
  const saves = [], dispatched = [], ui = [], removed = [], toasts = [], permissionWrites = [];
  let counter = 10;
  const context = {
    console, Map, Set, Date, setTimeout: () => 1,
    inputEl: { value: 'original request', classList: { add() {}, remove() {} } }, attachedFiles: [],
    currentConv: null, workspaceDraftId: ID_A, currentSessionId: null, currentModel: 'opus', currentEffort: 'high',
    currentProjectId: 'project-original', currentExecutionMode: { kind: 'default' },
    currentPermissionState: { permissionMode: 'acceptEdits', revision: 1 }, permissionMutation: null,
    permissionViewRevision: 0, permissionLoadPromise: null, syncPermissionControl() {},
    currentWorkingDir: { path: '/synthetic/original', name: 'original' }, currentMode: 'orchestrate',
    currentAgent: 'writer', currentAgentLabel: 'Writer', currentOrchestrateAgents: ['writer', 'analyst'],
    selectedQuickSkill: null, currentAssistantBubble: null, chatTitle: { textContent: 'original title' },
    providerRoutingLoaded: false, pendingConversationSends: new Set(), pendingConversationSaves: new Map(),
    unsavedWorkspaceConversations: new WeakSet(), runs: new Map(), jobToConv: new Map(), conversationControls: new Map(),
    supplementDrafts: new Map(), composerDrafts: new Map(), composerDraftOwner: {},
    newClientRunId: () => `10000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    isConvRunning: (id) => context.runs.has(id), showToast: (value) => toasts.push(value),
    runtimeModelForValue: (value) => `runtime:${value}`,
    configuredChatRoute: () => ({ providerId: 'provider-original' }),
    sessionRouteSnapshot: (route, tier) => ({ ...route, providerRevision: 1, routeTier: tier }),
    conversationSessionMatchesRoute: () => true, currentTier: () => ({ label: '专家' }),
    buildContextPreamble: () => 'synthetic prior history',
    renderAttachments() {}, setSelectedQuickSkill: (value) => { context.selectedQuickSkill = value; },
    hideSkillQuickPopup() {}, autoGrowInput() {}, scrollToBottom() {}, truncateByWidth: (text) => text,
    appendConversationTurnAnchor: () => ({ remove: () => removed.push('anchor') }),
    appendMessage: (role, text) => { ui.push({ type: 'message', role, text, conv: context.currentConv }); return { dataset: {}, remove: () => removed.push(role) }; },
    showRunError: (_run, text) => ui.push({ type: 'message', role: 'error', text, conv: context.currentConv }),
    newActivityState: () => ({ items: [], phase: 'running' }),
    // This harness records UI effects without mounting previous process DOM.
    retirePreviousTaskProcesses() {},
    appendActivityState: () => { ui.push({ type: 'activity', conv: context.currentConv }); return { isConnected: true }; },
    setRunning: (value) => ui.push({ type: 'running', value, conv: context.currentConv }),
    refreshConversationIndex: () => ui.push({ type: 'index', conv: context.currentConv }),
    emitConversationChanged: (id) => ui.push({ type: 'changed', id, conv: context.currentConv }),
    refreshHistoryList: async () => {},
    window: { RelayTaskContinuity: require('../renderer/task-continuity'), api: {
      permissions: {
        get: async id => ({ ok: true, conversationId: id, permissionMode: 'acceptEdits', revision: 1 }),
        set: async request => { permissionWrites.push(clone(request)); return { ok: true, ...request, revision: 2 }; },
      },
      history: { save: (conv) => { const pending = deferred(); saves.push({ conv: clone(conv), pending }); return pending.promise; } },
      runClaude: async (...args) => { dispatched.push(args); return { jobId: args[11], sessionId: 'accepted-session' }; },
    } },
  };
  vm.createContext(context);
  const metadataStart = source.indexOf('function applyPermissionMetadata(');
  const metadataEnd = source.indexOf('\nfunction syncPermissionControl', metadataStart);
  vm.runInContext(source.slice(metadataStart, metadataEnd), context);
  vm.runInContext(sendSource, context, { filename: 'app.js:send' });
  const getterStart = source.indexOf('window.relayConversationWorkspace = () => (');
  const getterEnd = source.indexOf('\n});', getterStart);
  vm.runInContext(source.slice(getterStart, getterEnd + 4), context);
  return { context, saves, dispatched, ui, removed, toasts, permissionWrites,
    send: (options) => context.send(options),
    resolve: (index = 0) => saves[index].pending.resolve({ id: saves[index].conv.id, updatedAt: `saved-${index}` }),
    switchToNew() {
      context.activateComposerDraft();
      context.currentConv = null; context.workspaceDraftId = ID_B; context.currentSessionId = null;
      context.currentModel = 'haiku'; context.currentEffort = 'low'; context.currentWorkingDir = { path: '/synthetic/new' };
      context.currentMode = 'plain'; context.currentAgent = null; context.currentOrchestrateAgents = null;
      context.currentProjectId = 'project-new'; context.currentExecutionMode = { kind: 'plan' };
      context.permissionViewRevision++;
      context.currentPermissionState = { permissionMode: 'default', revision: 1 };
      context.inputEl.value = 'new request'; context.chatTitle.textContent = 'new title';
    },
  };
}

test('permission wait sends the captured text files and skill without consuming a newer draft', async () => {
  const h = harness(), ready = deferred();
  h.context.attachedFiles = [{ path: '/original.txt', name: 'original.txt' }];
  h.context.selectedQuickSkill = { name: 'original-skill' };
  h.context.currentPermissionState = null;
  h.context.permissionLoadPromise = ready.promise;
  const pending = h.send();
  h.context.inputEl.value = 'newer draft';
  h.context.attachedFiles[0].name = 'changed-name.txt';
  h.context.attachedFiles.push({ path: '/newer.txt', name: 'newer.txt' });
  h.context.selectedQuickSkill = { name: 'newer-skill' };
  h.context.currentPermissionState = { permissionMode: 'acceptEdits', revision: 1 };
  ready.resolve(true); await new Promise(setImmediate);
  assert.equal(h.saves[0].conv.turns[0].user, 'original request');
  assert.equal(h.saves[0].conv.turns[0].files.length, 1);
  assert.equal(h.saves[0].conv.turns[0].files[0].name, 'original.txt');
  assert.equal(h.saves[0].conv.turns[0].skill.name, 'original-skill');
  h.resolve(); await pending;
  assert.equal(h.context.inputEl.value, 'newer draft');
  assert.equal(h.context.attachedFiles.length, 2);
  assert.equal(h.context.selectedQuickSkill.name, 'newer-skill');
});

test('switching empty draft owners during permission loading prevents the old submission', async () => {
  const h = harness(), ready = deferred();
  h.context.currentPermissionState = null;
  h.context.permissionLoadPromise = ready.promise;
  const pending = h.send();
  // Two unsaved conversations both have currentConv === null; owner identity
  // must still protect them even before either has a history record.
  h.context.activateComposerDraft();
  h.context.inputEl.value = 'different unsaved conversation';
  h.context.currentPermissionState = { permissionMode: 'acceptEdits', revision: 1 };
  ready.resolve(true);
  assert.equal((await pending).ok, false);
  assert.equal(h.saves.length, 0);
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.context.inputEl.value, 'different unsaved conversation');
});

test('a mode-only command cannot clear text typed while its permission change waits', async () => {
  const h = harness(), ready = deferred();
  h.context.inputEl.value = '/plan';
  h.context.setComposerExecutionMode = () => ready.promise;
  const pending = h.send();
  h.context.inputEl.value = 'new requirement entered while changing mode';
  ready.resolve(true);
  assert.equal((await pending).modeSelected, true);
  assert.equal(h.context.inputEl.value, 'new requirement entered while changing mode');
  assert.equal(h.saves.length, 0);
});

test('deferred first save dispatches original snapshots without assigning its ID or DOM to the new draft', async () => {
  const h = harness();
  const pending = h.send(); const sentConv = h.context.currentConv;
  assert.equal(sentConv.id, ID_A); assert.equal(h.context.pendingConversationSends.has(ID_A), true);
  h.switchToNew(); const uiCount = h.ui.length;
  h.resolve(); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.conversationId, ID_A);
  assert.equal(sentConv.updatedAt, 'saved-0');
  assert.equal(h.context.currentConv, null); assert.equal(h.context.workspaceDraftId, ID_B);
  assert.equal(h.context.chatTitle.textContent, 'new title'); assert.equal(h.ui.length, uiCount);
  assert.equal(h.dispatched.length, 1);
  const args = h.dispatched[0];
  assert.equal(args[0], 'original request'); assert.equal(args[2], 'orchestrate');
  assert.equal(args[4], 'runtime:opus'); assert.equal(args[5], 'high'); assert.equal(args[6], 'writer');
  assert.equal(args[7], '/synthetic/original'); assert.deepEqual(clone(args[8]), ['writer', 'analyst']);
  assert.equal(args[9], ID_A); assert.equal(args[12], ID_A);
  assert.equal(h.context.runs.get(ID_A).sessionModel, 'opus');
  assert.equal(sentConv.projectId, 'project-original'); assert.equal(h.saves[0].conv.projectId, 'project-original');
  assert.equal(sentConv.executionMode.kind, 'default'); assert.equal(args[15].kind, 'default');
  assert.equal(h.context.currentProjectId, 'project-new'); assert.equal(h.context.currentExecutionMode.kind, 'plan');
  assert.equal(h.permissionWrites[0].conversationId, ID_A);
  assert.equal(h.permissionWrites[0].permissionMode, 'acceptEdits');
  assert.equal(sentConv.permissionMode, 'acceptEdits');
  assert.equal(h.context.currentPermissionState.permissionMode, 'default');
  assert.equal(h.context.pendingConversationSends.size, 0);
});

test('two different drafts saved out of order keep distinct IDs and independent launches', async () => {
  const h = harness();
  const first = h.send(); const firstConv = h.context.currentConv;
  h.switchToNew(); const second = h.send(); const secondConv = h.context.currentConv;
  h.resolve(1); await second;
  const uiCount = h.ui.length; h.resolve(0); await first;
  assert.equal(h.context.currentConv, secondConv); assert.equal(secondConv.id, ID_B); assert.equal(firstConv.id, ID_A);
  assert.equal(h.ui.length, uiCount);
  assert.deepEqual(h.dispatched.map((args) => args[9]), [ID_B, ID_A]);
  assert.equal(h.context.runs.size, 2);
});

test('pending initial persistence blocks a second send in the same conversation before any second placeholder', async () => {
  const h = harness(); const first = h.send();
  h.context.inputEl.value = 'duplicate input';
  const second = await h.send();
  assert.equal(second.ok, false); assert.equal(h.saves.length, 1);
  assert.equal(h.context.currentConv.turns.length, 1);
  assert.equal(h.context.inputEl.value, 'duplicate input');
  h.resolve(); await first; assert.equal(h.dispatched.length, 1);
});

test('failed first persistence releases the send gate, restores its unedited draft and retries with the same folder ID', async () => {
  const h = harness(); h.context.attachedFiles = [{ path: '/synthetic/file.txt', name: 'file.txt' }];
  const first = h.send(); h.saves[0].pending.reject(new Error('synthetic disk error'));
  const failed = await first;
  assert.equal(failed.ok, false); assert.match(failed.error, /保存失败/);
  assert.equal(h.dispatched.length, 0); assert.equal(h.context.pendingConversationSends.size, 0);
  assert.equal(h.context.currentConv.turns.length, 0); assert.equal(h.context.currentConv.id, ID_A);
  assert.equal(h.context.inputEl.value, 'original request'); assert.equal(h.context.attachedFiles[0].name, 'file.txt');
  assert.deepEqual(h.removed, ['user', 'anchor']);
  const retried = h.send(); h.resolve(1); assert.equal((await retried).ok, true);
  assert.equal(h.saves[1].conv.id, ID_A); assert.equal(h.saves[1].conv.turns.length, 1);
});

test('a late save failure cleans only the old placeholder and preserves the new draft, attachments and title', async () => {
  const h = harness(); const first = h.send(); const original = h.context.currentConv;
  h.switchToNew(); h.context.attachedFiles = [{ path: '/synthetic/new-file.txt', name: 'new-file.txt' }];
  const uiCount = h.ui.length;
  h.saves[0].pending.reject(new Error('synthetic disk error')); const result = await first;
  assert.equal(result.ok, false); assert.equal(original.turns.length, 0); assert.equal(h.dispatched.length, 0);
  assert.equal(h.context.currentConv, null); assert.equal(h.context.workspaceDraftId, ID_B);
  assert.equal(h.context.inputEl.value, 'new request'); assert.equal(h.context.attachedFiles[0].name, 'new-file.txt');
  assert.equal(h.context.chatTitle.textContent, 'new title'); assert.equal(h.ui.length, uiCount); assert.deepEqual(h.removed, []);
});

test('a first send without opening files assigns its conversation ID synchronously before persistence', async () => {
  const h = harness(); h.context.workspaceDraftId = null;
  const pending = h.send(); const id = h.context.currentConv.id;
  assert.match(id, /^[a-f0-9-]{36}$/); assert.equal(h.saves[0].conv.id, id);
  h.resolve(); assert.equal((await pending).conversationId, id); assert.equal(h.dispatched[0][9], id);
});

test('workspace directory lookup reserves a stable draft UUID without writing history or changing the conversation UI', () => {
  const h = harness(); h.context.workspaceDraftId = null;
  const initialInput = h.context.inputEl.value, initialTitle = h.context.chatTitle.textContent;
  const first = h.context.window.relayConversationWorkspace();
  const repeated = h.context.window.relayConversationWorkspace();
  assert.match(first.conversationId, /^[a-f0-9-]{36}$/);
  assert.equal(repeated.conversationId, first.conversationId);
  assert.equal(first.workingDir, '/synthetic/original'); assert.equal(first.projectId, 'project-original');
  assert.equal(h.saves.length, 0); assert.equal(h.context.currentConv, null);
  assert.equal(h.context.workspaceDraftId, first.conversationId);
  assert.equal(h.context.chatTitle.textContent, initialTitle); assert.equal(h.context.inputEl.value, initialInput);
  assert.equal(h.context.pendingConversationSends.size, 0); assert.equal(h.ui.length, 0);
});

test('a failed permission binding launches nothing, removes its saved placeholder and retries the visible draft permission', async () => {
  const h = harness();
  const bind = h.context.window.api.permissions.set;
  h.context.window.api.permissions.set = async () => ({ ok: false, error: 'permission not confirmed' });
  const first = h.send(); h.resolve(0);
  for (let i = 0; i < 10 && h.saves.length < 2; i++) await Promise.resolve();
  assert.equal(h.saves.length, 2);
  assert.equal(h.saves[1].conv.turns.length, 0);
  assert.equal(h.context.pendingConversationSends.has(ID_A), true);
  assert.equal(h.dispatched.length, 0);
  h.resolve(1); assert.equal((await first).ok, false);
  assert.equal(h.context.inputEl.value, 'original request');
  h.context.window.api.permissions.set = bind;
  const retry = h.send(); h.resolve(2);
  assert.equal((await retry).ok, true);
  assert.equal(h.permissionWrites[0].permissionMode, 'acceptEdits');
  assert.equal(h.dispatched.length, 1);
});

test('first send adopts the UUID and directory previously exposed to files or a manual terminal', async () => {
  const h = harness(); h.context.workspaceDraftId = null;
  const selected = h.context.window.relayConversationWorkspace();
  assert.equal(h.saves.length, 0);
  const sending = h.send();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0].conv.id, selected.conversationId);
  assert.equal(h.saves[0].conv.title, 'original request'); assert.equal(h.saves[0].conv.turns.length, 1);
  assert.equal(h.saves[0].conv.terminalWorkspaceOnly, undefined);
  h.resolve(); await sending;
  assert.equal(h.dispatched[0][9], selected.conversationId);
  assert.equal(h.dispatched[0][7], selected.workingDir);
  assert.equal(h.context.window.relayConversationWorkspace().conversationId, selected.conversationId);
});

test('directory lookup remains independent of pending history persistence and follows the selected conversation', async () => {
  const h = harness(); const sending = h.send(), original = h.context.currentConv;
  const beforeSave = h.context.window.relayConversationWorkspace();
  assert.equal(beforeSave.conversationId, ID_A);
  assert.equal(h.saves.length, 1); assert.equal(h.dispatched.length, 0);
  assert.equal(original.turns.length, 1);
  h.switchToNew(); const uiCount = h.ui.length;
  const afterSwitch = h.context.window.relayConversationWorkspace();
  assert.equal(afterSwitch.conversationId, ID_B); assert.equal(afterSwitch.workingDir, '/synthetic/new');
  assert.equal(h.saves.length, 1); assert.equal(h.ui.length, uiCount);
  h.resolve(); await sending;
  assert.equal(h.dispatched[0][9], ID_A);
  assert.equal(h.context.currentConv, null); assert.equal(h.context.workspaceDraftId, ID_B);
  assert.equal(h.context.chatTitle.textContent, 'new title'); assert.equal(h.ui.length, uiCount);
});

test('directory lookup after a failed first save does not retry persistence or mutate the pending user draft', async () => {
  const h = harness(); const selected = h.context.window.relayConversationWorkspace();
  const sending = h.send(); h.saves[0].pending.reject(new Error('synthetic disk error'));
  assert.equal((await sending).ok, false);
  const uiCount = h.ui.length, before = clone(h.context.currentConv);
  const first = h.context.window.relayConversationWorkspace();
  const repeated = h.context.window.relayConversationWorkspace();
  assert.equal(first.conversationId, selected.conversationId); assert.equal(repeated.conversationId, selected.conversationId);
  assert.equal(first.workingDir, selected.workingDir);
  assert.equal(h.saves.length, 1); assert.equal(h.dispatched.length, 0); assert.equal(h.ui.length, uiCount);
  assert.deepEqual(clone(h.context.currentConv), before); assert.equal(h.context.inputEl.value, 'original request');
  const retry = h.send(); h.resolve(1); await retry;
  assert.equal(h.saves[1].conv.id, selected.conversationId); assert.equal(h.dispatched.length, 1);
});

test('legacy terminal-only history is renamed by its first prompt while manual titles remain intact', async () => {
  for (const renamed of [false, true]) {
    const h = harness();
    h.context.currentConv = { id: ID_A, title: renamed ? 'user custom title' : '终端工作区', terminalWorkspaceOnly: true, turns: [] };
    const sending = h.send(); h.resolve(); await sending;
    assert.equal(h.saves[0].conv.title, renamed ? 'user custom title' : 'original request');
    assert.equal(h.saves[0].conv.terminalWorkspaceOnly, undefined); assert.equal(h.saves[0].conv.id, ID_A);
  }
});

test('late canceled queue launch cannot clear the next run or overwrite its history', async () => {
  const h = harness(), launch = deferred(); h.context.window.api.runClaude = () => launch.promise;
  const pending = h.send(); h.resolve(); await new Promise(resolve => setImmediate(resolve));
  const conv = h.context.currentConv, original = h.context.runs.get(conv.id);
  original.pauseRequested = true;
  const replacement = { jobId: 'replacement', convId: conv.id };
  h.context.runs.set(conv.id, replacement); h.context.jobToConv.delete(original.jobId);
  const savedCount = h.saves.length, uiCount = h.ui.length;
  launch.resolve({ error: '任务已暂停', code: 'TURN_CANCELED' });
  assert.equal((await pending).ok, false);
  assert.equal(h.context.runs.get(conv.id), replacement); assert.equal(h.saves.length, savedCount);
  assert.equal(h.ui.length, uiCount);
});

test('a real startup failure while pause is pending releases its renderer run', async () => {
  const h = harness(), launch = deferred(); h.context.removeThinking = () => {}; h.context.appendActivityState = () => null; h.context.window.api.runClaude = () => launch.promise;
  const sending = h.send(); h.resolve(); await new Promise(resolve => setImmediate(resolve));
  const run = h.context.runs.get(ID_A); run.pauseRequested = true;
  launch.resolve({ error: 'synthetic directory failure' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.saves[1].conv.turns[0].error, 'synthetic directory failure'); h.resolve(1);
  assert.equal((await sending).ok, false); assert.equal(h.context.runs.size, 0);
  assert.equal(run.launchError, 'synthetic directory failure');
});
test('late successful admission during pause finalization does not delete the new pause marker', async () => {
  const h = harness(), launch = deferred(); h.context.window.api.runClaude = () => launch.promise;
  const sending = h.send(); h.resolve(); await new Promise(resolve => setImmediate(resolve));
  const run = h.context.runs.get(ID_A); run.finishing = true; run.pauseRequested = true;
  h.context.currentConv.paused = { runId: run.jobId };
  const savesBefore = h.saves.length;
  launch.resolve({ jobId: run.jobId }); await sending;
  assert.equal(h.context.currentConv.paused.runId, run.jobId);
  assert.equal(h.saves.length, savesBefore, 'finalization owns the pending history save');
});
