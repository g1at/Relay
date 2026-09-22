'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationPermissions } = require('../src/main/projects/conversation-permissions');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
function harness(mode = 'default', options = {}) {
  let settings = { permissionMode: mode };
  const records = new Map(), changes = [], controls = [], stops = [], writes = [];
  let pending = false, failSave = false;
  const service = createConversationPermissions({
    readSettings: () => clone(settings), writeSettings: value => { settings = clone(value); },
    loadConversation: id => records.has(id) ? clone(records.get(id)) : null,
    persistConversation: value => { if (failSave) throw Error('disk full'); records.set(value.id, clone(value)); writes.push(clone(value)); },
    hasPendingPermission: () => pending,
    applyRuntime: async (...args) => { controls.push(clone(args)); if (options.applyRuntime) return options.applyRuntime(...args); },
    stopRuntime: id => stops.push(id), onChanged: value => changes.push(clone(value)),
  });
  return { service, records, changes, controls, stops, writes,
    get settings() { return settings; }, set pending(value) { pending = value; }, set failSave(value) { failSave = value; },
    old(id, extra = {}) { records.set(id, { id, updatedAt: '2025-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z', pinned: true, title: 'keep title', turns: [], ...extra }); },
    create(id, extra = {}) { const value = { id, turns: [], ...extra }; service.protectSave(value, null); records.set(id, clone(value)); return value; },
  };
}

test('native reset atomically retires goal metadata without touching visible history or permission choice', () => {
  const h = harness('bypassPermissions');
  h.old('a', { sessionId: 'old', executionMode: { kind: 'goal' }, contextUsage: { totalTokens: 99 }, goalRecovery: { condition: 'old objective' },
    turns: [{ runId: 'older', executionMode: { kind: 'goal' }, assistant: 'historical' },
      { runId: 'live', executionMode: { kind: 'goal' }, contextUsage: { totalTokens: 99 }, goalRecovery: { condition: 'old objective' }, assistant: 'visible' }] });
  const before = h.service.get('a');
  const reset = h.service.resetContext('a', { sessionId: 'new', runId: 'live' });
  const saved = h.records.get('a');
  assert.equal(reset.executionMode.kind, 'default'); assert.equal(reset.permissionMode, 'bypassPermissions');
  assert.equal(reset.revision, before.revision + 1); assert.equal(saved.sessionId, 'new');
  assert.equal(saved.goalRecovery, null); assert.equal(saved.contextUsage, undefined);
  assert.equal(saved.updatedAt, '2025-01-01T00:00:00.000Z'); assert.equal(saved.pinned, true);
  assert.equal(saved.turns[0].executionMode.kind, 'goal'); assert.equal(saved.turns[0].assistant, 'historical');
  assert.equal(saved.turns[1].executionMode.kind, 'default'); assert.equal(saved.turns[1].contextUsage, undefined);
  assert.equal(saved.turns[1].assistant, 'visible'); assert.equal(h.controls.length, 0); assert.equal(h.changes.length, 1);
  h.service.resetContext('a', { sessionId: 'new', runId: 'live' });
  assert.equal(h.service.get('a').revision, reset.revision); assert.equal(h.changes.length, 1);
  const lateSave = { ...saved, executionMode: { kind: 'goal' }, permissionRevision: before.revision };
  h.service.protectSave(lateSave, saved); assert.equal(lateSave.executionMode.kind, 'default');
});

test('reset retains explicit and legacy plan guards and never changes future defaults', () => {
  for (const legacyPlan of [false, true]) {
    const h = harness(legacyPlan ? 'plan' : 'acceptEdits');
    h.old('a', { executionMode: { kind: 'plan' } });
    const defaults = h.service.get();
    const reset = h.service.resetContext('a', { sessionId: 'new' });
    assert.equal(reset.executionMode.kind, 'plan');
    assert.equal(reset.permissionMode, legacyPlan ? 'default' : 'acceptEdits');
    assert.equal(!!reset.legacyPlan, legacyPlan); assert.deepEqual(h.service.get(), defaults);
  }
});

test('reset during an awaited permission ACK rejects the old commit and never rolls back the discarded goal', async () => {
  const gate = deferred(); let committed = 0, rolledBack = 0;
  const h = harness('default', { applyRuntime: async () => {
    await gate.promise; const commit = () => committed++; commit.rollback = async () => { rolledBack++; }; return commit;
  } });
  h.old('a', { executionMode: { kind: 'goal' } });
  const pending = h.service.set({ conversationId: 'a', permissionMode: 'bypassPermissions' });
  const rejected = assert.rejects(pending, error => error.code === 'PERMISSION_CONFLICT' && error.contextReset === true);
  await tick(); h.service.resetContext('a', { sessionId: 'new' }); gate.resolve(); await rejected;
  assert.equal(committed, 0); assert.equal(rolledBack, 0); assert.deepEqual(h.stops, ['a']);
  assert.equal(h.service.get('a').executionMode.kind, 'default'); assert.equal(h.service.get('a').permissionMode, 'default');
});

test('a pre-reset queued goal update is rejected before reaching the new SDK context', async () => {
  const gate = deferred(), h = harness('default', { applyRuntime: () => gate.promise }); h.old('a');
  const first = h.service.set({ conversationId: 'a', permissionMode: 'acceptEdits' });
  const second = h.service.set({ conversationId: 'a', permissionMode: 'acceptEdits', executionMode: { kind: 'goal' } });
  const rejected = [first, second].map(pending => assert.rejects(pending, { code: 'PERMISSION_CONFLICT' }));
  await tick(); h.service.resetContext('a', { sessionId: 'new' }); gate.resolve(); await Promise.all(rejected);
  assert.equal(h.controls.length, 1); assert.equal(h.service.get('a').executionMode.kind, 'default');
  // A deliberate selection made after reset can proceed normally.
  await h.service.set({ conversationId: 'a', permissionMode: 'default', executionMode: { kind: 'plan' } });
  assert.equal(h.service.get('a').executionMode.kind, 'plan');
});

test('leaving goal mode atomically clears recovery while permission-only changes retain it', async () => {
  const h = harness(); h.old('goal', { executionMode: { kind: 'goal' }, goalRecovery: { condition: 'fixture objective' } });
  await h.service.set({ conversationId: 'goal', permissionMode: 'acceptEdits' });
  assert.equal(h.records.get('goal').goalRecovery.condition, 'fixture objective');
  await h.service.set({ conversationId: 'goal', permissionMode: 'acceptEdits', executionMode: { kind: 'default' } });
  assert.equal(h.records.get('goal').goalRecovery, null);
  assert.equal(h.writes.at(-1).executionMode.kind, 'default');
  assert.equal(h.records.get('goal').updatedAt, '2025-01-01T00:00:00.000Z');
});

test('new defaults retain each supported legacy choice; legacy plan stays separate and explicit', () => {
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan']) {
    const h = harness(mode), value = h.service.get();
    assert.equal(value.permissionMode, mode === 'plan' ? 'default' : mode);
    assert.equal(value.executionMode.kind, mode === 'plan' ? 'plan' : 'default');
    h.old('old'); const before = clone(h.records.get('old'));
    const migrated = h.service.get('old'); assert.equal(migrated.permissionMode, value.permissionMode);
    assert.equal(migrated.executionMode.kind, value.executionMode.kind);
    assert.equal(h.records.get('old').updatedAt, before.updatedAt); assert.equal(h.records.get('old').pinned, true);
    assert.equal(h.records.get('old').title, before.title);
  }
});

test('changing future defaults never changes unopened legacy history or an existing conversation', async () => {
  const h = harness('acceptEdits'); h.old('unopened'); h.create('existing');
  await h.service.set({ permissionMode: 'bypassPermissions' });
  assert.equal(h.service.get().permissionMode, 'bypassPermissions');
  assert.equal(h.service.get('unopened').permissionMode, 'acceptEdits');
  assert.equal(h.service.get('existing').permissionMode, 'acceptEdits');
  assert.equal(h.create('new').permissionMode, 'bypassPermissions');
  assert.equal(h.controls.length, 0); assert.equal(h.changes.length, 1);
});

test('explicit legacy conversation permissions override the migration baseline', () => {
  const h = harness('plan'); h.old('selected', { permissionMode: 'acceptEdits' });
  assert.equal(h.service.get('selected').permissionMode, 'acceptEdits');
  assert.equal(h.service.get('selected').executionMode.kind, 'default');
});

test('changing a base tier never silently exits inherited plan; explicit execution change does', async () => {
  const h = harness('plan'); h.old('old', { executionMode: { kind: 'default' } });
  let value = await h.service.set({ conversationId: 'old', permissionMode: 'bypassPermissions' });
  assert.equal(value.executionMode.kind, 'plan'); assert.equal(value.legacyPlan, true);
  value = await h.service.set({ conversationId: 'old', permissionMode: 'bypassPermissions', executionMode: { kind: 'default' } });
  assert.equal(value.executionMode.kind, 'default'); assert.equal(value.legacyPlan, undefined);
  assert.equal(h.service.get('old').executionMode.kind, 'default');
  assert.equal(h.service.get().executionMode.kind, 'plan');
});

test('clearing plan for future new conversations leaves unopened old history in plan', async () => {
  const h = harness('plan'); h.old('unopened');
  await h.service.set({ permissionMode: 'default', executionMode: { kind: 'default' } });
  assert.equal(h.create('new').executionMode.kind, 'default');
  assert.equal(h.service.get('unopened').executionMode.kind, 'plan');
});

test('history writes cannot overwrite host permission metadata, including explicit execution mode', async () => {
  const h = harness(); h.create('a');
  await h.service.set({ conversationId: 'a', permissionMode: 'acceptEdits', executionMode: { kind: 'plan' } });
  const saved = clone(h.records.get('a'));
  const stale = { id: 'a', permissionMode: 'bypassPermissions', permissionRevision: 999, permissionLegacyPlan: true, executionMode: { kind: 'default' }, turns: [{ assistant: 'latest output' }] };
  h.service.protectSave(stale, saved);
  for (const key of ['permissionMode', 'permissionRevision', 'permissionLegacyPlan', 'executionMode']) assert.deepEqual(stale[key], saved[key]);
  assert.equal(stale.turns[0].assistant, 'latest output');
  assert.equal(h.create('forged', { permissionMode: 'bypassPermissions' }).permissionMode, 'default');
});

test('runtime update waits for SDK acknowledgement, reloads newer output and changes only one conversation', async () => {
  const gate = deferred(), h = harness('default', { applyRuntime: () => gate.promise }); h.old('a'); h.old('b');
  h.service.get('a'); const work = h.service.set({ conversationId: 'a', permissionMode: 'acceptEdits' }); await tick();
  assert.equal(h.records.get('a').permissionMode, 'default'); assert.equal(h.changes.length, 0);
  h.records.get('a').turns.push({ assistant: 'arrived while awaiting SDK' });
  gate.resolve(); await work;
  assert.equal(h.records.get('a').turns.length, 1); assert.equal(h.records.get('a').permissionMode, 'acceptEdits');
  assert.equal(h.service.get('b').permissionMode, 'default'); assert.equal(h.controls.length, 1);
  assert.equal(h.records.get('a').updatedAt, '2025-01-01T00:00:00.000Z');
});

test('pending approval no longer blocks acknowledged permission changes', async () => {
  let committed = 0;
  const h = harness('default', { applyRuntime: async () => () => { committed++; assert.equal(h.records.get('a').permissionMode, 'bypassPermissions'); } });
  h.create('a'); h.pending = true;
  const result = await h.service.set({ conversationId: 'a', permissionMode: 'bypassPermissions' });
  assert.equal(result.ok, true); assert.equal(h.controls.length, 1); assert.equal(committed, 1); assert.equal(h.changes.length, 1);
});

test('approval arriving during SDK control is reconciled only after persistence without killing the runtime', async () => {
  const gate = deferred(); let committed = 0;
  const h = harness('default', { applyRuntime: async () => { await gate.promise; return () => { committed++; assert.equal(h.records.get('a').permissionMode, 'bypassPermissions'); }; } }); h.create('a');
  const work = h.service.set({ conversationId: 'a', permissionMode: 'bypassPermissions' }); await tick(); h.pending = true;
  assert.equal(committed, 0); assert.equal(h.records.get('a').permissionMode, 'default');
  gate.resolve(); await work;
  assert.equal(committed, 1); assert.deepEqual(h.stops, []); assert.equal(h.changes.length, 1);
});

test('a failed persistence never runs the callback that releases waiting approvals', async () => {
  let committed = 0;
  const h = harness('default', { applyRuntime: async () => () => committed++ }); h.create('a'); h.failSave = true;
  await assert.rejects(h.service.set({ conversationId: 'a', permissionMode: 'bypassPermissions' }), /disk full/);
  assert.equal(committed, 0); assert.equal(h.records.get('a').permissionMode, 'default'); assert.equal(h.changes.length, 0);
});

test('SDK rejection and persistence failure never commit or broadcast an unconfirmed tier', async () => {
  for (const diskFailure of [false, true]) {
    const h = harness('default', { applyRuntime: async () => { if (!diskFailure) throw Error('SDK rejected'); } }); h.create('a'); h.failSave = diskFailure;
    await assert.rejects(h.service.set({ conversationId: 'a', permissionMode: 'bypassPermissions' }), diskFailure ? /disk full/ : /SDK rejected/);
    assert.equal(h.records.get('a').permissionMode, 'default'); assert.deepEqual(h.stops, ['a']); assert.equal(h.changes.length, 0);
  }
});

test('deleting history during an acknowledged runtime change never recreates that history', async () => {
  const gate = deferred(), h = harness('default', { applyRuntime: () => gate.promise }); h.create('a');
  const work = h.service.set({ conversationId: 'a', permissionMode: 'acceptEdits' }); await tick(); h.records.delete('a'); gate.resolve();
  await assert.rejects(work, { code: 'CONVERSATION_NOT_FOUND' }); assert.equal(h.records.has('a'), false);
});

test('same-conversation mode changes and turn preparation are serialized; another conversation remains independent', async () => {
  const first = deferred(), h = harness('default', { applyRuntime: (id, next) => id === 'a' && next.permissionMode === 'acceptEdits' ? first.promise : undefined });
  h.create('a'); h.create('b');
  const one = h.service.set({ conversationId: 'a', permissionMode: 'acceptEdits' });
  const two = h.service.set({ conversationId: 'a', permissionMode: 'bypassPermissions' });
  let prepared = null; const three = h.service.withSnapshot('a', value => { prepared = value; });
  await h.service.set({ conversationId: 'b', permissionMode: 'acceptEdits' });
  assert.equal(prepared, null); assert.equal(h.records.get('a').permissionMode, 'default');
  first.resolve(); await Promise.all([one, two, three]);
  assert.equal(prepared.permissionMode, 'bypassPermissions'); assert.equal(prepared.revision, 3);
});

test('bad identifiers, unsupported modes and nonexistent conversations fail without creating records', async () => {
  const h = harness();
  for (const id of ['../outside', ['array']]) assert.throws(() => h.service.get(id), { code: 'INVALID_CONVERSATION' });
  assert.throws(() => h.service.get('missing'), { code: 'CONVERSATION_NOT_FOUND' });
  for (const permissionMode of ['plan', 'auto', 'dontAsk', '', null]) await assert.rejects(h.service.set({ permissionMode }), { code: 'INVALID_PERMISSION_MODE' });
  assert.equal(h.records.size, 0);
});

test('a stale revision cannot replace a permission selected from another window', async () => {
  const h = harness(); h.create('a'); const before = h.service.get('a');
  await h.service.set({ conversationId: 'a', permissionMode: 'acceptEdits', expectedRevision: before.revision });
  await assert.rejects(h.service.set({ conversationId: 'a', permissionMode: 'bypassPermissions', expectedRevision: before.revision }), error => {
    assert.equal(error.code, 'PERMISSION_CONFLICT'); assert.equal(error.current.permissionMode, 'acceptEdits'); return true;
  });
  assert.equal(h.controls.length, 1); assert.equal(h.service.get('a').permissionMode, 'acceptEdits');
});

test('rebinding a new draft plan preserves the inherited plan marker', async () => {
  const h = harness('plan'); h.create('a');
  const result = await h.service.set({ conversationId: 'a', permissionMode: 'acceptEdits', executionMode: { kind: 'plan' } });
  assert.equal(result.legacyPlan, true); assert.equal(result.executionMode.kind, 'plan');
});

test('a confirmed rollback after persistence failure preserves prior mode and pending requests', async () => {
  let released = 0, rolledBack = 0;
  const h = harness('default', { applyRuntime: async () => { const commit = () => released++; commit.rollback = async () => { rolledBack++; }; return commit; } });
  h.create('a'); h.pending = true; h.failSave = true;
  await assert.rejects(h.service.set({ conversationId: 'a', permissionMode: 'bypassPermissions' }), /disk full/);
  assert.equal(released, 0); assert.equal(rolledBack, 1); assert.deepEqual(h.stops, []); assert.equal(h.records.get('a').permissionMode, 'default');
});
