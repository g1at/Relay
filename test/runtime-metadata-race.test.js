'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function declaration(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  const next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
function fixture() {
  const conv = {
    id: 'chat-a', model: 'haiku', effort: 'low', sessionId: 'session-a', sessionModel: 'haiku',
    sessionProviderId: 'provider-a', sessionProviderRevision: 1,
    updatedAt: '2026-09-28T07:04:42.000Z',
    turns: [{ runId: 'run-a', user: 'first message', assistant: 'saved answer', ts: '2026-09-28T07:04:42.000Z' }],
  };
  const requests = [], saves = [], notices = [];
  const context = vm.createContext({
    currentConv: conv, currentModel: conv.model, currentEffort: conv.effort, currentSessionId: conv.sessionId,
    claudeRuntimeUIRevision: 0, pendingClaudeRuntimeSelection: null,
    providerRoutingLoaded: true, configuredChatRoute: () => ({ providerId: 'provider-a', providerRevision: 1 }),
    effortForTier: () => 'high', runtimeModelForValue: model => model,
    supportedEffortLevelsForTier: () => ['low', 'medium', 'high', 'max'],
    supportedClaudeModels: [], supportedClaudeProviderId: 'provider-a', contextUsageByConv: new Map(),
    btnModelSwitch: { disabled: false }, modelPopup: null,
    isConvRunning: () => false, updateModelSwitchUI() {}, rememberModelPopupHome() {},
    hideModelPopup() {}, renderContextUsage() {}, showToast: message => notices.push(message),
    window: { api: {
      setClaudeRuntime(id, model, effort) {
        const request = { ...deferred(), id, model, effort };
        requests.push(request);
        return request.promise;
      },
      history: { async save(value) { saves.push(clone(value)); return value; } },
    } },
  });
  for (const name of ['selectModelTier', 'selectEffortLevel']) vm.runInContext(declaration(name), context);
  const select = kind => kind === 'model'
    ? context.selectModelTier({ value: 'opus', label: '专家' })
    : context.selectEffortLevel('high');
  const success = (request, extra = {}) => request.resolve({
    ok: true, applied: true, providerId: 'provider-a', providerRevision: 1,
    routeTier: request.model, effort: request.effort,
    runtimePatch: { model: request.model, effort: request.effort, sessionModel: request.model },
    ...extra,
  });
  return { conv, context, requests, saves, notices, select, success };
}

for (const kind of ['model', 'effort']) {
  test(`${kind}: late completion after loading fresher history does not save the captured snapshot`, async () => {
    const h = fixture(), before = clone(h.conv);
    const selection = h.select(kind);
    const fresh = clone(h.conv);
    fresh.updatedAt = '2026-09-28T09:10:12.000Z';
    fresh.turns.push({ runId: 'run-b', user: 'new message', ts: fresh.updatedAt });
    h.context.currentConv = fresh;
    const freshBefore = clone(fresh);
    h.success(h.requests[0]);
    await selection;
    assert.deepEqual(h.saves, []);
    assert.deepEqual(h.conv, before);
    assert.deepEqual(fresh, freshBefore);
    assert.equal(fresh.turns[0].assistant, 'saved answer');
    assert.equal(h.context.pendingClaudeRuntimeSelection, null);
  });

  test(`${kind}: switching to another chat leaves both snapshots and the current session intact`, async () => {
    const h = fixture(), before = clone(h.conv);
    const selection = h.select(kind);
    const other = { id: 'chat-b', model: 'sonnet', effort: 'medium', turns: [] };
    h.context.currentConv = other;
    h.context.currentModel = 'sonnet';
    h.context.currentEffort = 'medium';
    h.context.currentSessionId = 'session-b';
    h.success(h.requests[0], { restartRequired: true, runtimePatch: { model: 'opus', effort: null, sessionId: null } });
    await selection;
    assert.deepEqual(h.conv, before);
    assert.deepEqual(other, { id: 'chat-b', model: 'sonnet', effort: 'medium', turns: [] });
    assert.equal(h.context.currentSessionId, 'session-b');
    assert.equal(h.context.currentEffort, 'medium');
    assert.deepEqual(h.saves, []);
    assert.deepEqual(h.notices, []);
  });

  test(`${kind}: applying host metadata preserves appended turns, their times, and activity time`, async () => {
    const h = fixture();
    const selection = h.select(kind);
    h.conv.updatedAt = '2026-09-28T09:10:12.000Z';
    h.conv.turns.push({ runId: 'run-b', user: 'new message', ts: h.conv.updatedAt });
    const turns = clone(h.conv.turns), timestamp = h.conv.updatedAt;
    h.success(h.requests[0]);
    await selection;
    assert.deepEqual(h.conv.turns, turns);
    assert.equal(h.conv.updatedAt, timestamp);
    assert.equal(h.conv.effort, 'high');
    assert.equal(h.conv.model, kind === 'model' ? 'opus' : 'haiku');
    assert.deepEqual(h.saves, []);
  });

  test(`${kind}: stale host results cannot mutate the conversation or report a spurious failure`, async () => {
    const h = fixture(), before = clone(h.conv);
    const selection = h.select(kind);
    h.requests[0].resolve({ ok: false, stale: true, message: 'obsolete selection', runtimePatch: { model: 'old', effort: null } });
    await selection;
    assert.deepEqual(h.conv, before);
    assert.deepEqual(h.saves, []);
    assert.deepEqual(h.notices, []);
    assert.equal(h.context.btnModelSwitch.disabled, false);
  });
}

test('older model completion cannot roll back a newer model and route selection', async () => {
  const h = fixture();
  const first = h.context.selectModelTier({ value: 'opus', label: '专家' });
  const second = h.context.selectModelTier({ value: 'sonnet', label: '思考' });
  h.success(h.requests[1], { runtimePatch: { model: 'sonnet', effort: 'medium', sessionModel: 'sonnet', sessionProviderRevision: 2 } });
  await second;
  const committed = clone(h.conv);
  h.success(h.requests[0], { restartRequired: true, runtimePatch: { model: 'opus', effort: null, sessionId: null } });
  await first;
  assert.deepEqual(h.conv, committed);
  assert.equal(h.context.currentModel, 'sonnet');
  assert.equal(h.context.currentEffort, 'medium');
  assert.equal(h.context.currentSessionId, 'session-a');
  assert.deepEqual(h.saves, []);
});

test('older effort completion cannot roll back a newer effort selection', async () => {
  const h = fixture();
  const first = h.context.selectEffortLevel('high');
  const second = h.context.selectEffortLevel('max');
  h.success(h.requests[1]); await second;
  h.success(h.requests[0]); await first;
  assert.equal(h.conv.effort, 'max');
  assert.equal(h.context.currentEffort, 'max');
  assert.deepEqual(h.saves, []);
});

test('an effort selection supersedes an outstanding model selection without restoring its session route', async () => {
  const h = fixture();
  const first = h.context.selectModelTier({ value: 'opus', label: '专家' });
  const second = h.context.selectEffortLevel('max');
  h.success(h.requests[1]); await second;
  h.success(h.requests[0], { restartRequired: true, runtimePatch: { model: 'opus', effort: null, sessionId: null } });
  await first;
  assert.equal(h.conv.model, 'opus');
  assert.equal(h.conv.effort, 'max');
  assert.equal(h.context.currentSessionId, 'session-a');
  assert.deepEqual(h.saves, []);
});

test('host runtime patches clear obsolete session fields while retaining content and null effort', async () => {
  const h = fixture(), turns = clone(h.conv.turns);
  const selection = h.select('model');
  h.success(h.requests[0], {
    restartRequired: true, providerId: 'provider-b',
    runtimePatch: { model: 'opus', effort: null, sessionId: null, sessionModel: null,
      sessionProviderId: null, sessionProviderRevision: null, sessionRouteTier: null,
      sessionAgentEnvironment: null, carryContextOnNextTurn: 'provider', contextUsage: null },
  });
  await selection;
  assert.deepEqual(h.conv.turns, turns);
  assert.equal(h.conv.sessionId, null);
  assert.equal(h.conv.sessionProviderId, undefined);
  assert.equal(h.conv.sessionModel, undefined);
  assert.equal(h.conv.carryContextOnNextTurn, 'provider');
  assert.equal(h.context.currentSessionId, null);
  assert.equal(h.context.currentEffort, null);
  assert.deepEqual(h.saves, []);
});

test('a failed newer model selection restores committed metadata instead of the older pending preview', async () => {
  const h = fixture();
  const first = h.context.selectModelTier({ value: 'opus', label: '专家' });
  const second = h.context.selectModelTier({ value: 'sonnet', label: '思考' });
  h.requests[1].resolve({ ok: false, message: 'configured model rejected' });
  await second;
  h.success(h.requests[0]); await first;
  assert.equal(h.context.currentModel, 'haiku');
  assert.equal(h.context.currentEffort, 'low');
  assert.equal(h.conv.model, 'haiku');
  assert.deepEqual(h.notices, ['configured model rejected']);
  assert.deepEqual(h.saves, []);
});

test('a failed newer effort selection restores committed effort instead of an older pending preview', async () => {
  const h = fixture();
  const first = h.context.selectEffortLevel('high');
  const second = h.context.selectEffortLevel('max');
  h.requests[1].reject(Error('effort rejected'));
  await second;
  h.success(h.requests[0]); await first;
  assert.equal(h.context.currentEffort, 'low');
  assert.equal(h.conv.effort, 'low');
  assert.deepEqual(h.notices, ['effort rejected']);
  assert.deepEqual(h.saves, []);
});

test('failed effort selection restores an absent saved effort to the default', async () => {
  const h = fixture();
  delete h.conv.effort;
  h.context.currentEffort = null;
  const first = h.context.selectEffortLevel('high');
  const second = h.context.selectEffortLevel('max');
  h.requests[1].resolve({ ok: false, message: 'effort rejected' });
  await second;
  h.success(h.requests[0]); await first;
  assert.equal(h.context.currentEffort, null);
  assert.equal(h.conv.effort, undefined);
  assert.deepEqual(h.saves, []);
});
