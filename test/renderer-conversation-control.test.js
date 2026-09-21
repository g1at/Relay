'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { declaration } = require('./renderer-activity-harness.cjs');
function deferred() { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const control = deferred(), saved = deferred(), calls = [], prompts = [], notices = [];
  const conv = { id: 'A', turns: [], paused: null };
  const run = { convId: 'A', jobId: 'run-A', turnIndex: 0, turn: {} };
  const steering = deferred(), steers = []; let uuid = 0;
  conv.turns.push({ runId: run.jobId });
  const context = {
    followUpMode: 'steer',
    console, Map, Promise, Date, setTimeout, currentConv: conv, pageNavigationVersion: 1, activeView: 'settings',
    runs: new Map([['A', run]]), conversationControls: new Map(), supplementDrafts: new Map(),
    composerDrafts: new Map(), composerDraftOwner: {},
    inputEl: { value: 'new instruction' }, attachedFiles: [{ path: '/synthetic/a.txt' }], selectedQuickSkill: { name: 'review' },
    window: {
      RelayConversationContext: require('../renderer/conversation-context'),
      RelayAssistantOutput: require('../renderer/assistant-output'),
      RelaySupplementTimeline: require('../renderer/supplement-timeline'),
      api: { pauseClaude: async id => { calls.push(id); return control.promise; }, steerClaude: async request => { steers.push(request); return steering.promise; } },
    },
    newClientRunId: () => `input-${++uuid}`, isMountedChatJob: () => false,
    setSelectedQuickSkill(value) { context.selectedQuickSkill = value; }, renderAttachments() {}, hideSkillQuickPopup() {}, autoGrowInput() {}, syncRunningUI() {},
    showToast(value) { notices.push(value); },
    async send(options) { prompts.push({ ...options, conv: context.currentConv.id }); return { ok: true }; },
    async finishRun(id) { assert.equal(id, run.jobId); run.finishing = true; run.finishPromise = saved.promise.then(() => { conv.paused = { runId: id }; context.runs.delete('A'); }); return run.finishPromise; },
  };
  vm.createContext(context);
  for (const name of ['readComposerDraft', 'captureComposerDraft', 'renderComposerDraft', 'sameComposerContent',
    'sameRecoveredSupplementContent', 'composerMatchesSupplement', 'clearSupplementComposer', 'clearDeliveredSupplementComposer',
    'outputStateForRun', 'pauseRun', 'pauseCurrent', 'submitSupplement', 'applyRunSupplement', 'steerCurrent']) vm.runInContext(declaration(name), context);
  return { context, run, conv, control, saved, calls, prompts, notices, steering, steers };
}
function acceptance(request, status = 'queued') {
  return { ok: true, input: { id: request.messageId, text: request.prompt, files: request.files, skill: request.skill, ts: new Date().toISOString(), status } };
}
test('supplement writes to the original run without pausing, waiting for a terminal save, or relaunching', async () => {
  const h = harness(), launch = deferred(); h.run.launchPromise = launch.promise;
  const operation = h.context.steerCurrent(); await tick();
  assert.equal(h.steers.length, 1); assert.equal(h.calls.length, 0); assert.equal(h.context.inputEl.value, '');
  const request = h.steers[0]; assert.equal(request.jobId, 'run-A'); assert.equal(request.conversationId, 'A');
  assert.equal(request.files[0].path, '/synthetic/a.txt'); assert.equal(request.skill.name, 'review');
  h.context.inputEl.value = 'later draft'; h.context.attachedFiles = [{ path: '/synthetic/b.txt' }];
  assert.equal((await h.context.steerCurrent()).pending, true);
  h.steering.resolve(acceptance(request)); assert.equal((await operation).ok, true);
  assert.equal(h.prompts.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.run.pauseRequested, undefined);
  assert.equal(h.context.runs.get('A'), h.run); assert.equal(h.conv.turns.length, 1);
  assert.equal(h.conv.turns[0].supplements[0].text, 'new instruction');
  assert.equal(h.context.inputEl.value, 'later draft'); assert.equal(h.context.attachedFiles[0].path, '/synthetic/b.txt');
  assert.equal(h.context.supplementDrafts.size, 0); assert.equal(h.context.conversationControls.size, 0);
});
test('rejected or uncertain supplement retains a stable retry ID and never interrupts', async () => {
  for (const reject of [true, false]) {
    const h = harness(), operation = h.context.steerCurrent(); await tick();
    if (reject) h.steering.reject(new Error('connection lost'));
    else h.steering.resolve({ ok: false, code: 'NOT_READY', message: 'not ready' });
    assert.equal((await operation).ok, false);
    const draft = h.context.supplementDrafts.get('A');
    assert.equal(draft.prompt, 'new instruction'); assert.equal(draft.messageId, h.steers[0].messageId);
    assert.equal(h.calls.length, 0); assert.equal(h.prompts.length, 0); assert.equal(h.run.abortRequested, undefined);
  }
});
test('navigation during submission cannot redirect accepted input or overwrite the other draft', async () => {
  const h = harness(), operation = h.context.steerCurrent(); await tick();
  h.context.currentConv = { id: 'B' }; h.context.inputEl.value = 'B draft';
  h.steering.resolve(acceptance(h.steers[0])); assert.equal((await operation).ok, true);
  assert.equal(h.run.turn.supplements[0].text, 'new instruction'); assert.equal(h.context.currentConv.supplements, undefined);
  assert.equal(h.context.inputEl.value, 'B draft'); assert.equal(h.calls.length, 0); assert.equal(h.prompts.length, 0);
});
test('accepted event before lost receipt suppresses retries and queued receipts never downgrade applied', async () => {
  for (const lost of [true, false]) {
    const h = harness(), operation = h.context.steerCurrent(); await tick();
    h.context.applyRunSupplement(h.run, acceptance(h.steers[0], 'applied').input);
    if (lost) h.steering.reject(new Error('lost reply')); else h.steering.resolve(acceptance(h.steers[0]));
    assert.equal((await operation).ok, true); assert.equal(h.context.supplementDrafts.size, 0);
    assert.equal(h.run.turn.supplements.length, 1); assert.equal(h.run.turn.supplements[0].status, 'applied');
  }
});
test('late acceptance or rejection never starts a new run after natural completion', async () => {
  for (const ok of [true, false]) {
    const h = harness(), operation = h.context.steerCurrent(); await tick();
    h.run.finishing = true; h.context.runs.delete('A'); h.conv.turns[0].assistant = 'final answer';
    h.steering.resolve(ok ? acceptance(h.steers[0]) : { ok: false, code: 'NOT_RUNNING' });
    assert.equal((await operation).ok, ok); assert.equal(h.calls.length, 0); assert.equal(h.prompts.length, 0);
    assert.equal(h.conv.turns[0].assistant, 'final answer'); assert.equal(h.conv.turns.length, 1);
  }
});

for (const nextRun of [false, true]) {
  test(`retry after both acceptance receipts are lost reconciles the original run (${nextRun ? 'another run is active' : 'original run completed'})`, async () => {
    const h = harness(), first = h.context.steerCurrent(); await tick();
    const acceptedRequest = { ...h.steers[0] };
    const acceptedInput = acceptance(acceptedRequest, 'applied').input;
    // Main already accepted this UUID, but neither its streamed event nor its
    // invoke reply reached the renderer. Retrying must query that original job.
    h.steering.reject(Error('both acceptance receipts lost'));
    assert.equal((await first).ok, false);
    const draft = h.context.supplementDrafts.get('A');
    assert.equal(draft.messageId, acceptedRequest.messageId);
    assert.equal(draft.jobId, 'run-A');
    h.context.runs.delete('A');
    h.conv.turns[0].assistant = 'original authoritative final';
    let newer = null;
    if (nextRun) {
      newer = { convId: 'A', jobId: 'run-B', turnIndex: 1, turn: { runId: 'run-B', supplements: [] } };
      h.context.runs.set('A', newer); h.conv.turns.push(newer.turn);
      const guarded = await h.context.steerCurrent({ explicit: true, ...draft });
      assert.equal(guarded.pending, true);
      assert.equal(h.steers.length, 1, 'a direct old-run retry is refused before touching the newer run');
    }
    h.context.window.api.steerClaude = async request => {
      h.steers.push(request);
      assert.equal(request.jobId, 'run-A');
      assert.equal(request.messageId, acceptedRequest.messageId);
      return { ok: true, duplicate: true, input: acceptedInput };
    };
    await h.context.submitSupplement(draft, 'A');
    assert.equal(h.steers.length, 2, 'completed-run retry must reach backend idempotence');
    assert.equal(h.prompts.length, 0, 'uncertain delivery must never become a new send');
    assert.equal(h.calls.length, 0, 'recovery must not interrupt another run');
    assert.equal(h.conv.turns[0].assistant, 'original authoritative final');
    assert.equal(h.context.supplementDrafts.has('A'), false);
    if (newer) {
      assert.equal(h.context.runs.get('A'), newer);
      assert.deepEqual(newer.turn.supplements, []);
    } else assert.equal(h.context.runs.has('A'), false);
  });
}

test('asynchronous delivery failure preserves drafts and authoritative correction withdraws only its own retry', async () => {
  for (const status of ['rejected', 'canceled']) {
    const h = harness(), operation = h.context.steerCurrent(); await tick();
    const request = h.steers[0];
    h.steering.resolve(acceptance(request));
    assert.equal((await operation).ok, true);
    assert.equal(h.context.supplementDrafts.size, 0);
    h.context.applyRunSupplement(h.run, acceptance(request, status).input);
    const restored = h.context.supplementDrafts.get('A');
    assert.equal(restored.prompt, request.prompt);
    assert.equal(restored.jobId, 'run-A');
    assert.equal(restored.sendAsNew, true);
    assert.notEqual(restored.messageId, request.messageId);
    assert.equal(h.prompts.length, 0); assert.equal(h.steers.length, 1); assert.equal(h.calls.length, 0);
    h.context.applyRunSupplement(h.run, acceptance(request, 'applied').input);
    assert.equal(h.run.turn.supplements[0].status, 'applied');
    assert.equal(h.context.supplementDrafts.has('A'), false);

    const other = { jobId: 'run-A', messageId: 'another-uncertain-input', prompt: 'keep this draft' };
    h.context.supplementDrafts.set('A', other);
    h.context.applyRunSupplement(h.run, { ...acceptance(request, status).input, id: 'second-failed-input' });
    assert.equal(h.context.supplementDrafts.get('A'), other, 'a late failure cannot overwrite a different pending draft');
  }
});

test('pause-only and resume do not consume the composer draft or send it implicitly', async () => {
  const h = harness(); const operation = h.context.pauseCurrent(); await tick();
  await h.context.pauseCurrent(); assert.equal(h.calls.length, 1);
  h.control.resolve({ paused: true, settled: true }); await tick(); h.saved.resolve(); await operation;
  assert.equal(h.prompts.length, 0); assert.equal(h.context.inputEl.value, 'new instruction');
  await h.context.pauseCurrent(); assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].intent, 'resume'); assert.equal(h.prompts[0].resumeOf, 'run-A');
  assert.equal(h.prompts[0].prompt, undefined); assert.equal(h.prompts[0].files.length, 0);
  assert.equal(h.context.inputEl.value, 'new instruction');
});

test('brief unregistered window retries by exact run ID without waiting for launch', async () => {
  const h = harness(); let attempts = 0;
  h.context.window.api.pauseClaude = async id => { assert.equal(id, 'run-A'); return ++attempts < 3 ? { settled: false, code: 'NOT_REGISTERED' } : { paused: true, settled: true }; };
  const pending = h.context.pauseCurrent(); await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(attempts, 3); assert.equal(h.prompts.length, 0);
  h.saved.resolve(); await pending;
});
test('already-finished status waits for a delayed authoritative terminal event and its save', async () => {
  const h = harness();
  h.context.window.api.pauseClaude = async () => ({ settled: true, alreadyFinished: true, task: { state: 'succeeded' } });
  const pending = h.context.pauseCurrent();
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(h.prompts.length, 0); assert.equal(h.run.finishing, undefined, 'a status summary cannot finalize text');
  h.run.finishing = true;
  h.run.finishPromise = h.saved.promise.then(() => { h.conv.turns[0].assistant = 'authoritative final answer'; h.context.runs.delete('A'); });
  h.saved.resolve(); await pending;
  assert.equal(h.conv.turns[0].assistant, 'authoritative final answer'); assert.equal(h.prompts.length, 0);
});

test('one composer button switches pause, send and continue based on task state and draft', () => {
  const h = harness(), classes = new Set(), actions = [];
  h.context.sendBtn = { classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } }, setAttribute() {} };
  h.context.isRunning = true; h.context.inputEl.value = ''; h.context.attachedFiles = [];
  vm.runInContext(declaration('syncComposerAction'), h.context);
  vm.runInContext(declaration('submitComposer'), h.context);
  h.context.pauseCurrent = () => actions.push('pause-or-continue'); h.context.send = () => actions.push('send');
  h.context.syncComposerAction(); assert.equal(classes.has('is-stop'), true); assert.equal(h.context.sendBtn.title, '暂停当前任务');
  h.context.submitComposer(); assert.deepEqual(actions, ['pause-or-continue']);
  h.context.inputEl.value = 'supplement'; h.context.syncComposerAction();
  assert.equal(classes.has('is-stop'), false); assert.match(h.context.sendBtn.title, /调整方向/);
  h.context.submitComposer(); assert.equal(actions[1], 'send');
  h.context.inputEl.value = ''; h.context.attachedFiles = [{ path: '/synthetic/image.png' }]; h.context.syncComposerAction();
  assert.equal(classes.has('is-stop'), false, 'attachment-only input is sendable');
  h.context.isRunning = false; h.context.attachedFiles = []; h.conv.paused = { runId: 'old' }; h.context.syncComposerAction();
  assert.equal(classes.has('is-resume'), true); assert.equal(h.context.sendBtn.title, '继续任务');
  h.context.inputEl.value = 'new draft'; h.context.syncComposerAction(); assert.equal(classes.has('is-resume'), false);
  h.context.conversationControls.set('A', Promise.resolve()); h.context.syncComposerAction();
  assert.equal(h.context.sendBtn.disabled, true);
});

test('model-switch history carries supplemental requirements, attachments and unhandled status', () => {
  const h = harness(); vm.runInContext(declaration('buildContextPreamble'), h.context);
  const text = h.context.buildContextPreamble([{ user: 'inspect project', assistant: 'report', supplements: [
    { text: 'focus module two', status: 'applied', files: [{ path: '/synthetic/requirements.md' }] },
    { text: 'also review limits', status: 'canceled' },
  ] }]);
  assert.match(text, /focus module two/); assert.match(text, /\/synthetic\/requirements\.md/);
  assert.match(text, /尚未处理.*also review limits/);
});
