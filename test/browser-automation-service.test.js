'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createBrowserAutomationService } = require('../src/main/browser/browser-automation-service');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options = {}) {
  const tabs = new Map(), events = [], calls = [], adapters = [];
  let serial = 0, currentHost;
  function add(id = `tab-${++serial}`, extra = {}) {
    const item = { id, privateSession: false, presented: true, backgroundCapable: true,
      webContents: { isDestroyed: () => false, getURL: () => 'https://example.test/', getTitle: () => 'Example' }, ...extra };
    tabs.set(id, item); return item;
  }
  const host = { getAutomationTarget: id => tabs.get(id), invoke: async input => {
    calls.push(input);
    if (input.action === 'create') { const item = add(); return { ok: true, tab: { id: item.id, url: input.url, title: 'Example' } }; }
    return { ok: true };
  } };
  currentHost = host;
  const service = createBrowserAutomationService({ getHost: () => currentHost, onEvent: event => { events.push(event); options.onEvent?.(event, tabs); }, visibilityTimeoutMs: options.visibilityTimeoutMs ?? 35,
    createAdapter: options.createAdapter || (() => {
      const version = adapters.length + 1;
      let observed = false;
      const adapter = { disposed: false, dispose() { this.disposed = true; },
        async observe({ check }) { check(); observed = true; return { observationId: `observation-${version}`, elements: [{ ref: 'e1' }] }; },
        async act(input, { check }) { check(); if (!observed || input.observationId !== `observation-${version}`) throw Object.assign(new Error('请重新观察'), { code: 'STALE_OBSERVATION' }); return { executed: true }; },
        async verify(_input, { check }) { check(); return { verified: true }; },
        async wait(_input, { check }) { check(); return { satisfied: true }; },
        async diagnostics(_input, { check }) { check(); return { events: [], cursor: 0 }; },
        async upload(input, { check }) { check(); calls.push(input); return { executed: true, fileCount: input.files.length }; },
        async screenshot({ check }) { check(); return { data: 'cG5n', mimeType: 'image/png' }; },
      }; adapters.push(adapter); return adapter;
    }) });
  const ctx = (conversationId = 'task-a', runId = 'run-a', extra = {}) => ({ conversationId, runId, isCurrent: () => true, ...extra });
  const claim = (id, conversationId = 'task-a') => service.control({ action: 'claim', id, conversationId });
  return { service, tabs, host, events, calls, adapters, add, ctx, claim, setHost: value => { currentHost = value; } };
}

test('a model can only list and operate task-bound tabs, never claim tabs or forge ownership', async () => {
  const f = fixture(); f.add('manual'); f.add('other'); f.claim('other', 'task-b');
  assert.deepEqual(await f.service.invoke(f.ctx(), { action: 'list' }), { ok: true, tabs: [] });
  assert.equal((await f.service.invoke(f.ctx(), { action: 'observe', id: 'manual', conversationId: 'task-b' })).code, 'TAB_NOT_OWNED');
  assert.equal((await f.service.invoke(f.ctx(), { action: 'observe', id: 'other', conversationId: 'task-b' })).code, 'TAB_NOT_OWNED');
  assert.equal((await f.service.invoke(f.ctx(), { action: 'claim', id: 'manual' })).code, 'INVALID_ACTION');
  assert.equal(f.claim('other').code, 'TAB_ALREADY_OWNED');
  f.claim('manual');
  assert.equal((await f.service.invoke(f.ctx(), { action: 'list' })).tabs[0].id, 'manual');
});

test('open binds to the trusted task and emits a presentation event', async () => {
  const f = fixture();
  const result = await f.service.invoke(f.ctx(), { action: 'open', url: 'https://example.test/', conversationId: 'forged' });
  assert.equal(result.ok, true); assert.equal(result.tab.conversationId, 'task-a');
  assert.deepEqual(f.calls, [{ action: 'create', url: 'https://example.test/', conversationId: 'task-a' }]);
  const event = f.events.find(event => event.type === 'automation-open');
  assert.equal(event.conversationId, 'task-a'); assert.equal(event.tab.id, result.tab.id);
});

test('focus waits for renderer presentation and never changes the host active tab directly', async () => {
  const f = fixture({ visibilityTimeoutMs: 1000 }); f.add('tab', { presented: false }); f.claim('tab');
  f.host.activateTab = () => { throw Error('renderer must own activation'); };
  let settled = false;
  const pending = f.service.invoke(f.ctx(), { action: 'focus', id: 'tab' }).then(result => { settled = true; return result; });
  await tick(); assert.equal(settled, false);
  const event = f.events.find(event => event.type === 'automation-open');
  assert.equal(event.tab.id, 'tab'); assert.equal(event.conversationId, 'task-a');
  assert.ok(event.tab.revision > 0);
  f.tabs.get('tab').presented = true;
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.tab.presented, true); assert.equal(result.requiresObservation, true);
});

test('a background focus fails honestly without any host activation or input', async () => {
  const f = fixture(); f.add('tab', { presented: false }); f.claim('tab');
  const result = await f.service.invoke(f.ctx(), { action: 'focus', id: 'tab' });
  assert.equal(result.code, 'BROWSER_NOT_VISIBLE'); assert.equal(result.outcome, undefined);
  assert.equal(f.adapters.length, 0); assert.equal(f.calls.length, 0);
});

test('hidden input keeps its task lease and never requests presentation or replays the action', async () => {
  const f = fixture({ onEvent(event, tabs) {
    if (event.type === 'automation-open') tabs.get(event.tab.id).presented = true;
  } });
  f.add('tab'); f.claim('tab');
  const observation = await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' });
  f.tabs.get('tab').presented = false;
  const result = await f.service.invoke(f.ctx(), { action: 'act', id: 'tab', kind: 'click', ref: 'e1', observationId: observation.observationId });
  assert.equal(result.executed, true);
  assert.equal(f.events.filter(event => event.type === 'automation-open').length, 0);
  assert.equal(f.tabs.get('tab').presented, false);
});

test('losing a background render host revokes only its task and preserves the actual pause reason', async () => {
  const ready = deferred();
  const f = fixture({ createAdapter: () => ({ dispose() {}, async observe(options) {
    await options.waitForBackgroundReady(); return { observationId: 'ready-page', elements: [] };
  } }) });
  f.add('tab', { presented: false, backgroundReady: ready.promise }); f.claim('tab');
  f.add('other'); f.claim('other', 'task-b');
  const pending = f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' });
  await tick(); f.service.handleHostEvent({ type: 'background-unavailable', id: 'tab' });
  const interrupted = await pending;
  assert.equal(interrupted.code, 'AUTOMATION_PAUSED');
  assert.match(interrupted.error, /渲染环境已中断/); assert.doesNotMatch(interrupted.error, /用户已接管/);
  ready.resolve(); await tick();
  const blocked = await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' });
  assert.equal(blocked.code, 'AUTOMATION_PAUSED'); assert.match(blocked.error, /渲染环境已中断/);
  assert.equal((await f.service.invoke(f.ctx('task-b'), { action: 'observe', id: 'other' })).ok, true);
  assert.equal(f.events.filter(event => event.type === 'automation-open').length, 0);
  f.service.control({ action: 'resume', id: 'tab' });
  assert.equal((await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' })).ok, true);
});

test('native close still publishes release when the host throws for an already removed tab', async () => {
  const f = fixture(); f.add('tab'); f.claim('tab'); let forwarded = false;
  f.host.getAutomationTarget = id => {
    if (!f.tabs.has(id)) throw Object.assign(Error('closed native page'), { code: 'TAB_NOT_FOUND' });
    return f.tabs.get(id);
  };
  f.host.closeTab = id => {
    f.tabs.delete(id);
    f.service.handleHostEvent({ type: 'closed', id });
    forwarded = true;
    return { ok: true };
  };
  const result = await f.service.invoke(f.ctx(), { action: 'close', id: 'tab' });
  assert.equal(result.ok, true); assert.equal(forwarded, true);
  assert.equal(f.events.at(-1).state, 'unbound');
  assert.equal((await f.service.invoke(f.ctx(), { action: 'list' })).tabs.length, 0);
});

test('human takeover during presentation cancels the wait without dispatching input', async () => {
  const f = fixture({ visibilityTimeoutMs: 1000 }); f.add('tab', { presented: false }); f.claim('tab');
  const pending = f.service.invoke(f.ctx(), { action: 'focus', id: 'tab' });
  await tick(); f.service.control({ action: 'pause', id: 'tab' }); f.tabs.get('tab').presented = true;
  assert.equal((await pending).code, 'AUTOMATION_PAUSED'); assert.equal(f.adapters.length, 0);
});

test('background readiness waits without presenting the tab and takeover cancels it', async () => {
  const ready = deferred(); let read = 0;
  const f = fixture({ createAdapter: () => ({ dispose() {}, async observe(options) {
    await options.waitForBackgroundReady(); read++;
    return { observationId: 'ready-page', elements: [] };
  } }) });
  f.add('tab', { presented: false, backgroundReady: ready.promise }); f.claim('tab');
  const pending = f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' });
  await tick(); assert.equal(read, 0);
  f.service.control({ action: 'pause', id: 'tab' });
  assert.equal((await pending).code, 'AUTOMATION_PAUSED');
  ready.resolve(); await tick();
  assert.equal(read, 0);
  assert.equal(f.events.some(event => event.type === 'automation-open'), false);
});

test('background readiness rechecks the original target before adapter work', async () => {
  const ready = deferred(); let read = 0;
  const f = fixture({ createAdapter: () => ({ dispose() {}, async observe(options) {
    await options.waitForBackgroundReady(); read++;
    return { observationId: 'ready-page', elements: [] };
  } }) });
  f.add('tab', { presented: false, backgroundReady: ready.promise }); f.claim('tab');
  const pending = f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' });
  await tick(); f.tabs.get('tab').webContents = { isDestroyed: () => false }; ready.resolve();
  assert.equal((await pending).code, 'STALE_TARGET'); assert.equal(read, 0);
});

test('a failed host input preflight rejects before adapter side effects or download arming', async () => {
  const f = fixture(); f.add('tab'); f.claim('tab');
  const prepared = [];
  f.host.prepareAutomationInput = async (_id, descriptor) => {
    prepared.push(descriptor.method);
    throw Object.assign(Error('Document remains hidden'), { code: 'BROWSER_NOT_VISIBLE' });
  };
  f.host.beginAutomationDownload = () => { throw Error('must not arm a download'); };
  for (const action of ['act', 'upload', 'download']) {
    const result = await f.service.invoke(f.ctx(), { action, id: 'tab', kind: 'fill', text: 'new value' });
    assert.equal(result.code, 'BROWSER_NOT_VISIBLE'); assert.equal(result.outcome, 'not-executed');
  }
  assert.equal((await f.service.invoke(f.ctx(), { action: 'focus', id: 'tab' })).code, 'BROWSER_NOT_VISIBLE');
  assert.deepEqual(prepared, ['visibility', 'visibility', 'visibility', 'visibility']);
  assert.equal(f.adapters.length, 0);
});

test('hidden open reports the existing created tab so presentation failure cannot imply a retryable create', async () => {
  const f = fixture({ onEvent(event, tabs) {
    if (event.type === 'automation-open') tabs.get(event.tab.id).presented = false;
  } });
  const result = await f.service.invoke(f.ctx(), { action: 'open', url: 'https://example.test/' });
  assert.equal(result.ok, true); assert.equal(result.presentation.ready, false);
  assert.equal(result.tab.presented, false); assert.equal(f.tabs.size, 1);
  assert.equal((await f.service.invoke(f.ctx(), { action: 'list' })).tabs[0].id, result.tab.id);
});

test('feedback resume survives run completion but cannot override a newer human control decision', async () => {
  const f = fixture(); f.add('tab'); const claimed = f.claim('tab');
  const paused = f.service.control({ action: 'pause', id: 'tab' });
  assert.ok(paused.revision > claimed.revision); assert.ok(paused.controlRevision > claimed.controlRevision);
  f.service.pauseConversation('task-a', 'run-finished');
  const ended = f.service.control({ action: 'state', id: 'tab' });
  assert.ok(ended.revision > paused.revision); assert.equal(ended.controlRevision, paused.controlRevision);
  assert.equal(f.service.control({ action: 'resume', id: 'tab', expectedControlRevision: paused.controlRevision }).ok, true);
  const first = f.service.control({ action: 'pause', id: 'tab' });
  f.service.control({ action: 'pause', id: 'tab' });
  assert.equal(f.service.control({ action: 'resume', id: 'tab', expectedControlRevision: first.controlRevision }).code, 'STALE_LEASE');
  assert.equal(f.service.control({ action: 'state', id: 'tab' }).state, 'paused');
  f.service.control({ action: 'release', id: 'tab' }); f.claim('tab'); f.service.control({ action: 'pause', id: 'tab' });
  assert.equal(f.service.control({ action: 'resume', id: 'tab', expectedControlRevision: first.controlRevision }).code, 'STALE_LEASE');
});

test('cancelled open retains the newly created page but releases its automation ownership', async () => {
  const f = fixture(), controller = new AbortController(), pending = deferred();
  f.host.invoke = async () => { await pending.promise; f.add('new'); return { ok: true, tab: { id: 'new' } }; };
  const operation = f.service.invoke(f.ctx('task-a', 'run-a', { signal: controller.signal }), { action: 'open', url: 'https://example.test/' });
  controller.abort(); pending.resolve();
  assert.equal((await operation).code, 'AUTOMATION_ABORTED');
  assert.equal(f.tabs.has('new'), true);
  assert.equal(f.service.control({ action: 'state', id: 'new' }).state, 'unbound');
  assert.equal(f.events.some(event => event.type === 'automation-open'), false);
});

test('planned tasks can read authorized pages but cannot open or perform inputs', async () => {
  const f = fixture(); f.add('tab'); f.claim('tab'); const ctx = f.ctx('task-a', 'run-a', { readOnly: true });
  for (const action of ['open', 'act', 'upload', 'download']) assert.equal((await f.service.invoke(ctx, { action, id: 'tab' })).code, 'PLAN_MODE_READ_ONLY');
  for (const action of ['list', 'observe', 'verify', 'wait', 'diagnostics', 'downloads', 'screenshot']) assert.equal((await f.service.invoke(ctx, { action, id: 'tab', text: 'ok' })).ok, true);
  assert.equal(f.calls.length, 0);
});

test('stale runs and changed webContents cannot dispatch adapter operations', async () => {
  const f = fixture(); f.add('tab'); f.claim('tab');
  assert.equal((await f.service.invoke(f.ctx('task-a', 'old', { isCurrent: () => false }), { action: 'observe', id: 'tab' })).code, 'STALE_RUN');
  assert.equal(f.adapters.length, 0);
  f.add('tab');
  assert.equal((await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' })).code, 'STALE_TARGET');
  assert.equal(f.adapters.length, 0);
  assert.equal(f.service.control({ action: 'state', id: 'tab' }).state, 'unbound');
});

test('private tabs cannot be claimed and host replacement revokes old targets', async () => {
  const f = fixture(); f.add('private', { privateSession: true });
  assert.equal(f.claim('private').code, 'PRIVATE_TAB');
  f.add('tab'); f.claim('tab'); f.setHost({ ...f.host });
  assert.equal((await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' })).code, 'STALE_TARGET');
});

test('listing cannot disclose a replacement page that reused a tab ID', async () => {
  const f = fixture(); f.add('tab'); f.claim('tab');
  f.add('tab', { webContents: { isDestroyed: () => false, getURL: () => { throw new Error('must not read new page'); } } });
  assert.deepEqual(await f.service.invoke(f.ctx(), { action: 'list' }), { ok: true, tabs: [] });
  assert.equal(f.service.control({ action: 'state', id: 'tab' }).state, 'unbound');
});

test('a run superseded during a wait cannot dispatch delayed input', async () => {
  const wait = deferred(); let activeRun = true, inputs = 0;
  const f = fixture({ createAdapter: () => ({ dispose() {}, async act(_input, { check }) { await wait.promise; check(); inputs++; return { executed: true }; } }) });
  f.add('tab'); f.claim('tab');
  const operation = f.service.invoke(f.ctx('task-a', 'old', { isCurrent: () => activeRun }), { action: 'act', id: 'tab', kind: 'click', ref: 'e1', observationId: 'o' });
  await tick(); activeRun = false; wait.resolve();
  assert.equal((await operation).code, 'STALE_RUN'); assert.equal(inputs, 0);
});

test('pause cancels a running wait and queued actions immediately; resumed control invalidates references', async () => {
  const waiting = deferred(); let observedCheck, dispatched = 0, disposed = 0, adapters = 0;
  const f = fixture({ createAdapter: () => {
    adapters++;
    return { dispose() { disposed++; }, async observe({ check }) { observedCheck = check; await waiting.promise; check(); return { observationId: `v${adapters}` }; },
      async act(_input, { check }) { check(); dispatched++; return { executed: true }; } };
  } });
  f.add('tab'); f.claim('tab');
  const running = f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' }); await tick();
  const queued = f.service.invoke(f.ctx(), { action: 'act', id: 'tab', observationId: 'v1', kind: 'click', ref: 'e1' });
  assert.equal(f.service.control({ action: 'pause', id: 'tab' }).state, 'paused');
  assert.equal((await running).code, 'AUTOMATION_PAUSED'); assert.equal((await queued).code, 'AUTOMATION_PAUSED');
  assert.throws(observedCheck, error => error.code === 'AUTOMATION_PAUSED');
  assert.equal(dispatched, 0); assert.equal(disposed, 1);
  waiting.resolve(); await tick();
  assert.equal((await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' })).code, 'AUTOMATION_PAUSED');
  f.service.control({ action: 'resume', id: 'tab', conversationId: 'task-a' });
  assert.equal((await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' })).ok, true);
  assert.equal(adapters, 2);
});

test('only one operation dispatches per tab; separate tabs may run in parallel', async () => {
  const waiting = deferred(), started = []; let active = 0, maxActive = 0;
  const f = fixture({ createAdapter: ({ webContents }) => ({ dispose() {}, async observe({ check }) {
    check(); active++; maxActive = Math.max(maxActive, active); started.push(webContents);
    await waiting.promise; check(); active--; return { observationId: 'seen' };
  } }) });
  f.add('a'); f.add('b'); f.claim('a'); f.claim('b');
  const a1 = f.service.invoke(f.ctx(), { action: 'observe', id: 'a' });
  const a2 = f.service.invoke(f.ctx(), { action: 'observe', id: 'a' });
  const b1 = f.service.invoke(f.ctx(), { action: 'observe', id: 'b' });
  await tick(); assert.equal(started.length, 2); assert.equal(maxActive, 2);
  waiting.resolve(); const results = await Promise.all([a1, a2, b1]);
  assert.equal(results.every(result => result.ok), true); assert.equal(started.length, 3);
});

test('new runs and explicit resume require fresh observations', async () => {
  const f = fixture(); f.add('tab'); f.claim('tab');
  const first = await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' });
  const action = { action: 'act', id: 'tab', kind: 'click', observationId: first.observationId, ref: 'e1' };
  assert.equal((await f.service.invoke(f.ctx(), action)).ok, true);
  f.service.control({ action: 'pause', id: 'tab' }); f.service.control({ action: 'resume', id: 'tab' });
  assert.equal((await f.service.invoke(f.ctx(), action)).code, 'STALE_OBSERVATION');
  const second = await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' });
  assert.notEqual(first.observationId, second.observationId);
  assert.equal((await f.service.invoke(f.ctx('task-a', 'run-b'), { ...action, observationId: second.observationId })).code, 'STALE_OBSERVATION');
});

test('run cancellation immediately stops waits without permanently taking control from the next run', async () => {
  const wait = deferred(), controller = new AbortController();
  const f = fixture({ createAdapter: () => ({ dispose() {}, async observe({ check }) { await wait.promise; check(); return { text: 'ready' }; } }) });
  f.add('tab'); f.claim('tab');
  const running = f.service.invoke(f.ctx('task-a', 'run-a', { signal: controller.signal }), { action: 'observe', id: 'tab' });
  await tick(); controller.abort();
  assert.equal((await running).code, 'AUTOMATION_ABORTED');
  assert.equal(f.service.control({ action: 'state', id: 'tab' }).state, 'controlled');
  wait.resolve();
  assert.equal((await f.service.invoke(f.ctx('task-a', 'run-b'), { action: 'observe', id: 'tab' })).ok, true);
  f.service.control({ action: 'pause', id: 'tab' }); f.service.pauseConversation('task-a', 'run-finished');
  assert.equal(f.service.control({ action: 'state', id: 'tab' }).state, 'paused');
});

test('a dispatched action with uncertain completion is never retried and reports the unknown outcome', async () => {
  let attempts = 0;
  const f = fixture({ createAdapter: () => ({ dispose() {}, async act() { attempts++; throw new Error('transport lost'); } }) });
  f.add('tab'); f.claim('tab');
  const result = await f.service.invoke(f.ctx(), { action: 'act', id: 'tab', kind: 'click', ref: 'e1', observationId: 'x' });
  assert.equal(result.ok, false); assert.equal(result.outcome, 'unknown'); assert.equal(result.retryable, false); assert.equal(attempts, 1);
});

test('only explicit adapter evidence that no input was sent reports not-executed', async () => {
  for (const evidence of [false, true, undefined]) {
    const f = fixture({ createAdapter: () => ({ dispose() {}, async act() {
      throw Object.assign(new Error('目标已变化'), { code: 'BROWSER_ELEMENT_STALE', inputDispatched: evidence });
    } }) });
    f.add('tab'); f.claim('tab');
    const result = await f.service.invoke(f.ctx(), { action: 'act', id: 'tab', kind: 'click', ref: 'e1', observationId: 'x' });
    assert.equal(result.outcome, evidence === false ? 'not-executed' : 'unknown');
    if (evidence !== false) assert.equal(result.retryable, false);
  }
});

test('hosts without background support reject inputs before side effects without auto-presenting', async () => {
  const f = fixture(); f.add('tab', { presented: false, backgroundCapable: false }); f.claim('tab');
  assert.equal((await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' })).ok, true);
  for (const action of ['act', 'upload', 'download', 'screenshot']) assert.equal((await f.service.invoke(f.ctx(), { action, id: 'tab', kind: 'scroll' })).code, 'BROWSER_BACKGROUND_UNAVAILABLE');
  assert.equal(f.events.some(event => event.type === 'automation-open'), false);
});

test('release and host close clear ownership in both returned and emitted UI state', async () => {
  const f = fixture(); f.add('tab'); f.claim('tab'); await f.service.invoke(f.ctx(), { action: 'observe', id: 'tab' });
  const released = f.service.control({ action: 'release', id: 'tab' });
  assert.equal(released.state, 'unbound'); assert.equal(released.conversationId, null);
  assert.equal(f.events.at(-1).conversationId, null); assert.equal(f.adapters[0].disposed, true);
  f.claim('tab'); f.service.handleHostEvent({ type: 'closed', id: 'tab' });
  assert.equal(f.service.control({ action: 'state', id: 'tab' }).state, 'unbound');
  assert.equal(f.events.at(-1).conversationId, null);
});

async function fileContext(t, f) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-service-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspaceRoot, 'fixture.txt'), 'fixture');
  return f.ctx('task-a', 'run-a', { workspaceRoot });
}
test('upload resolves files from host context and refuses path traversal before adapter input', async t => {
  const f = fixture(); f.add('tab'); f.claim('tab'); const ctx = await fileContext(t, f);
  const result = await f.service.invoke(ctx, { action: 'upload', id: 'tab', observationId: 'o', ref: 'e1', files: ['fixture.txt'] });
  assert.equal(result.ok, true); assert.equal(result.fileCount, 1);
  assert.deepEqual(f.calls.at(-1).files, [path.join(ctx.workspaceRoot, 'fixture.txt')]);
  const before = f.calls.length;
  const denied = await f.service.invoke(ctx, { action: 'upload', id: 'tab', files: ['../outside.txt'], workspaceRoot: os.tmpdir() });
  assert.equal(denied.code, 'BROWSER_UPLOAD_OUTSIDE_WORKSPACE'); assert.equal(f.calls.length, before);
});
test('download is armed before click, waits for completion and only lists artifacts for its task', async t => {
  const ready = deferred(), order = [];
  const f = fixture({ createAdapter: () => ({ dispose() {}, async act(_input, { check }) { check(); order.push('click'); return { executed: true }; } }) });
  f.add('tab'); f.claim('tab'); const ctx = await fileContext(t, f);
  f.host.beginAutomationDownload = (_id, options) => {
    options.check(); order.push('arm'); assert.equal(options.directory, path.join(ctx.workspaceRoot, 'browser-downloads'));
    return { result: ready.promise, cancel() { order.push('cancel'); } };
  };
  const operation = f.service.invoke(ctx, { action: 'download', id: 'tab', observationId: 'o', ref: 'e1' });
  while (!order.includes('click')) await tick();
  assert.deepEqual(order, ['arm', 'click']);
  assert.deepEqual((await f.service.invoke(ctx, { action: 'downloads' })).downloads, []);
  const artifact = { id: 'file-id', state: 'completed', path: path.join(ctx.workspaceRoot, 'file.csv'), filename: 'file.csv', size: 4, sha256: 'fixture-digest' };
  ready.resolve(artifact);
  const result = await operation;
  assert.equal(result.ok, true); assert.equal(result.download.sha256, artifact.sha256);
  assert.equal(result.download.tabId, 'tab'); assert.equal(order.at(-1), 'cancel');
  assert.equal((await f.service.invoke(ctx, { action: 'downloads' })).downloads.length, 1);
  assert.deepEqual((await f.service.invoke(f.ctx('task-b'), { action: 'downloads' })).downloads, []);
  f.service.control({ action: 'release', id: 'tab' });
  assert.equal((await f.service.invoke(ctx, { action: 'downloads' })).downloads.length, 1, 'completed files outlive page control');
});
test('preflight failure cancels an armed download without retrying its click', async t => {
  let clicks = 0, cancellations = 0;
  const f = fixture({ createAdapter: () => ({ dispose() {}, async act() {
    clicks++; throw Object.assign(new Error('stale'), { code: 'BROWSER_ELEMENT_STALE', inputDispatched: false });
  } }) });
  f.add('tab'); f.claim('tab'); const ctx = await fileContext(t, f);
  f.host.beginAutomationDownload = () => ({ result: new Promise(() => {}), cancel() { cancellations++; } });
  const result = await f.service.invoke(ctx, { action: 'download', id: 'tab', observationId: 'o', ref: 'e1' });
  assert.equal(result.outcome, 'not-executed'); assert.equal(clicks, 1); assert.equal(cancellations, 1);
});
test('human takeover cancels pending downloads and never records late completion', async t => {
  const started = deferred(); let cancelled = false;
  const f = fixture({ createAdapter: () => ({ dispose() {}, async act() { started.resolve(); return { executed: true }; } }) });
  f.add('tab'); f.claim('tab'); const ctx = await fileContext(t, f);
  f.host.beginAutomationDownload = (_id, { signal }) => ({
    result: new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), { code: 'DOWNLOAD_CANCELLED' })), { once: true })),
    cancel() { cancelled = true; },
  });
  const operation = f.service.invoke(ctx, { action: 'download', id: 'tab', observationId: 'o', ref: 'e1' });
  await started.promise; f.service.control({ action: 'pause', id: 'tab' });
  const result = await operation; await tick();
  assert.equal(result.ok, false); assert.equal(cancelled, true);
  assert.deepEqual((await f.service.invoke(ctx, { action: 'downloads' })).downloads, []);
});

test('completed files remain recorded when takeover races with the post-click observation', async t => {
  const clicked = deferred(), finishClick = deferred(), completed = deferred(); let armed = false;
  const f = fixture({ createAdapter: () => ({ dispose() {}, async act(_input, options) {
    options.check(); options.beforeClick(); clicked.resolve(); await finishClick.promise; options.check(); return { executed: true };
  } }) });
  f.add('tab'); f.claim('tab'); const ctx = await fileContext(t, f);
  f.host.beginAutomationDownload = () => ({ result: completed.promise, arm() { armed = true; }, cancel() {} });
  const operation = f.service.invoke(ctx, { action: 'download', id: 'tab', observationId: 'o', ref: 'e1' });
  await clicked.promise; assert.equal(armed, true);
  completed.resolve({ id: 'completed-file', state: 'completed', path: 'fixture.csv', sha256: 'verified-before-takeover', size: 1 });
  await tick(); f.service.control({ action: 'pause', id: 'tab' });
  assert.equal((await operation).code, 'AUTOMATION_PAUSED');
  assert.equal((await f.service.invoke(ctx, { action: 'downloads' })).downloads[0].sha256, 'verified-before-takeover');
  assert.deepEqual((await f.service.invoke(f.ctx('task-b'), { action: 'downloads' })).downloads, []);
  finishClick.resolve(); await tick();
});

test('navigation, activation and close require ownership; closed events do not report an unknown successful close', async () => {
  const f = fixture(); f.add('t'); f.add('other'); f.claim('t');
  f.host.navigateTab = (id,url) => { f.calls.push({id,url}); return {ok:true}; };
  f.host.activateTab = id => ({ok:true,id});
  f.host.closeTab = id => { f.service.handleHostEvent({type:'closed',id}); f.tabs.delete(id); return {ok:true}; };
  const observation = await f.service.invoke(f.ctx(),{action:'observe',id:'t'});
  assert.equal((await f.service.invoke(f.ctx(),{action:'navigate',id:'other',kind:'goto',url:'https://x.test'})).code,'TAB_NOT_OWNED');
  assert.equal((await f.service.invoke(f.ctx('task-a','run-a',{readOnly:true}),{action:'navigate',id:'t',kind:'reload'})).code,'PLAN_MODE_READ_ONLY');
  assert.equal((await f.service.invoke(f.ctx(),{action:'navigate',id:'t',kind:'goto',url:'https://x.test'})).requiresObservation,true);
  assert.equal(f.adapters[0].disposed,true);
  assert.equal((await f.service.invoke(f.ctx(),{action:'act',id:'t',kind:'click',ref:'e1',observationId:observation.observationId})).code,'STALE_OBSERVATION');
  assert.equal((await f.service.invoke(f.ctx(),{action:'focus',id:'t'})).ok,true);
  assert.equal((await f.service.invoke(f.ctx(),{action:'close',id:'t'})).closed,true);
  assert.equal((await f.service.invoke(f.ctx(),{action:'list'})).tabs.length,0);
});

test('restored task tabs require explicit human resume and shutdown retains paused recovery binding', async () => {
  const f=fixture(), bindings=[]; f.add('restored'); f.host.setTaskBinding=(id,value)=>bindings.push({id,...value});
  f.service.handleHostEvent({type:'task-restored',id:'restored',conversationId:'task-a'});
  assert.equal((await f.service.invoke(f.ctx(),{action:'observe',id:'restored'})).code,'AUTOMATION_PAUSED');
  assert.equal((await f.service.invoke(f.ctx('task-b'),{action:'list'})).tabs.length,0);
  f.service.control({action:'resume',id:'restored',conversationId:'task-a'});
  assert.equal((await f.service.invoke(f.ctx(),{action:'observe',id:'restored'})).ok,true);
  f.service.dispose(); assert.equal(bindings.at(-1).state,'paused'); assert.equal(bindings.at(-1).conversationId,'task-a');
});

for (const waitFor of [undefined, { event:'navigation', waitUntil:'load' }]) test('host-tagged popup retains the action result and any unmet event condition: '+!!waitFor, async () => {
  let f, token;
  f=fixture({createAdapter:()=>({dispose(){},async act(_input,options){
    const cleanup=await options.onInput({method:'Input.synthesizeTapGesture',params:{x:10,y:10}});
    f.add('child');f.service.handleHostEvent({type:'created',id:'child',openerId:'parent',automationOperationId:token});
    await cleanup?.();f.tabs.get('parent').presented=false;
    throw Object.assign(new Error('opener hidden'),{code:'BROWSER_NOT_VISIBLE',inputDispatched:true});
  }})});
  f.add('parent');f.claim('parent');f.host.armAutomationPopup=(_id,value)=>{token=value;return()=>{token=null}};
  const result=await f.service.invoke(f.ctx(),{action:'act',id:'parent',kind:'click',observationId:'o',ref:'e1',waitFor});
  assert.equal(result.ok,true);assert.equal(result.requiresObservation,true);assert.equal(result.openedTabs[0].id,'child');
  if(waitFor) assert.deepEqual(result.waitResult,{event:'navigation',satisfied:false,cancelled:true,reason:'opener-hidden-by-popup'});
  else assert.equal(result.waitResult,undefined);
  f.add('unsolicited');f.service.handleHostEvent({type:'created',id:'unsolicited',openerId:'parent',automationOperationId:'forged'});
  assert.equal((await f.service.invoke(f.ctx(),{action:'list'})).tabs.length,2);
  assert.equal((await f.service.invoke(f.ctx('task-b'),{action:'list'})).tabs.length,0);
});
