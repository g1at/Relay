'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _execTool } = require('../src/main/scheduling/cron-mcp');
const schedulerPath = require.resolve('../src/main/scheduling/scheduler');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scheduler-media-'));
  delete require.cache[schedulerPath];
  const scheduler = require(schedulerPath);
  const calls = [], saved = [], history = new Map();
  scheduler.init({
    userDataDir: dir, buildMemoryHint: () => '', readAppSettings: () => ({}),
    refreshTray() {}, notify() {}, getMainWindow: () => null,
    saveConversation: value => { saved.push(structuredClone(value)); history.set(value.id, structuredClone(value)); },
    loadConversation: id => history.has(id) ? structuredClone(history.get(id)) : null,
    runClaudeJob: () => { throw new Error('Media task must not start a chat'); },
    generateMedia: async input => { calls.push(input); return { ok: true, paths: ['/fixture/clip.mp4'], artifacts: [{ path: '/fixture/clip.mp4', kind: 'video' }], taskId: 'media-task-exact', state: 'succeeded', mediaKind: 'video' }; },
    ...overrides,
  });
  t.after(() => { scheduler.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); delete require.cache[schedulerPath]; });
  const create = (action = {}, delivery = {}) => {
    const result = scheduler.create({ name: 'Media fixture', enabled: false, schedule: { kind: 'every', everyMs: 60000 },
      action: { type: 'video', prompt: 'A cube', mediaModel: 'provider-one::media::video', parameters: { duration: 2, resolution: '480P', audio: false }, ...action },
      delivery: { notify: false, saveToHistory: true, ...delivery },
    });
    assert.equal(result.ok, true, result.error);
    return result.task;
  };
  return { scheduler, create, calls, saved, dir };
}

async function completed(scheduler, id) {
  const deadline = Date.now() + 2000;
  while (scheduler.get(id).running) {
    if (Date.now() > deadline) assert.fail('scheduler media did not complete');
    await new Promise(resolve => setImmediate(resolve));
  }
  return scheduler.runs(id)[0];
}

test('video schedule persists exact binding, parameters and references and forwards its durable run ID', async t => {
  const h = fixture(t);
  const references = [{ url: 'https://fixture.invalid/frame.png', role: 'first_frame', mime: 'image/png' }];
  const task = h.create({ references });
  assert.equal(h.scheduler.get(task.id).action.type, 'video');
  assert.deepEqual(h.scheduler.get(task.id).action.references, references);
  const receipt = await h.scheduler.runNow(task.id);
  const run = await completed(h.scheduler, task.id);
  assert.equal(h.calls.length, 1);
  const input = h.calls[0];
  assert.equal(input.model, 'provider-one::media::video');
  assert.equal(input.mediaKind, 'video');
  assert.equal(input.runId, receipt.runId);
  assert.deepEqual(input.source, { type: 'schedule', runId: receipt.runId });
  assert.equal(input.duration, 2);
  assert.equal(input.audio, false);
  assert.equal(input.n, undefined, 'video must not inherit legacy image quantity');
  assert.deepEqual(input.references, references);
  assert.equal(run.status, 'ok');
  assert.equal(run.mediaTaskId, 'media-task-exact');
  assert.equal(h.saved[0].kind, 'create');
  assert.equal(input.conversationId, h.saved[0].id, 'media recovery and completion events retain their history owner');
  assert.equal(input.conversationId, run.mediaSnapshot.historyConversationId);
  assert.equal(h.saved[0].turns[0].mediaKind, 'video');
  assert.equal(h.saved[0].turns[0].mediaTaskId, 'media-task-exact');
  assert.deepEqual(h.saved[0].turns[0].resultPaths, ['/fixture/clip.mp4']);
});

for (const state of ['needs_attention', 'submission_unknown', 'stopped', 'download_failed']) {
  test(`${state} retains the original media task and never becomes scheduler success or a resubmission`, async t => {
    let submissions = 0;
    const h = fixture(t, { generateMedia: async () => { submissions += 1; return { ok: state === 'download_failed', taskId: 'original-media-task', state, recoverable: true }; } });
    const task = h.create();
    await h.scheduler.runNow(task.id);
    const run = await completed(h.scheduler, task.id);
    assert.equal(run.status, 'error');
    assert.equal(run.mediaTaskId, 'original-media-task');
    assert.equal(run.mediaState, state);
    assert.equal(run.recoverable, true);
    assert.match(run.error, /original-media-task.*未自动重新提交/);
    assert.equal(submissions, 1);
    assert.equal(h.saved.length, 1, 'pending media remains reachable through its history turn');
    assert.equal(h.saved[0].turns[0].mediaTaskId, 'original-media-task');
  });
}

test('media cancellation reaches the service and retains its media task ID', async t => {
  let input;
  const h = fixture(t, { generateMedia: request => { input = request; return new Promise(resolve => {
    request.signal.addEventListener('abort', () => resolve({ ok: false, canceled: true, taskId: 'canceled-media-task', state: 'stopped' }), { once: true });
  }); } });
  const task = h.create();
  const receipt = await h.scheduler.runNow(task.id);
  assert.ok(input);
  assert.equal(h.scheduler.cancelRun(receipt.runId), true);
  const run = await completed(h.scheduler, task.id);
  assert.equal(input.signal.aborted, true);
  assert.equal(run.status, 'canceled');
  assert.equal(run.mediaTaskId, 'canceled-media-task');
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].turns[0].mediaTaskId, 'canceled-media-task');
});

test('legacy image actions keep the old executor fallback and normalized media bindings omit injected n', async t => {
  const legacyCalls = [];
  const h = fixture(t, { generateMedia: undefined, generateImage: async input => { legacyCalls.push(input); return { ok: true, paths: ['/fixture/image.png'] }; } });
  const task = h.create({ type: 'image', mediaModel: null, imageModel: 'provider-old::gpt-image-2', size: '1K', n: 1, parameters: {} });
  await h.scheduler.runNow(task.id);
  assert.equal((await completed(h.scheduler, task.id)).status, 'ok');
  assert.equal(legacyCalls[0].model, 'provider-old::gpt-image-2');
  assert.equal(legacyCalls[0].size, '1K');
  const video = h.create();
  await h.scheduler.runNow(video.id);
  assert.match((await completed(h.scheduler, video.id)).error, /视频生成服务未就绪/);
});

test('new image actions use only explicitly selected parameters', async t => {
  const h = fixture(t);
  const task = h.create({ type: 'image', mediaModel: 'provider-one::media::z-image', parameters: { size: '512*512' } });
  await h.scheduler.runNow(task.id);
  await completed(h.scheduler, task.id);
  assert.equal(h.calls[0].mediaKind, 'image');
  assert.equal(h.calls[0].n, undefined);
  assert.equal(h.calls[0].size, '512*512');
});

test('cron MCP creates and sparsely updates video configuration through the real scheduler', async t => {
  const h = fixture(t);
  const added = await _execTool(h.scheduler, 'cron_add', { name: 'MCP video fixture', type: 'video', everyMs: 3600000,
    prompt: 'A cube', mediaModel: 'provider-one::media::video', parameters: { duration: 2, audio: false },
    references: [{ url: 'https://fixture.invalid/frame.png', role: 'first_frame' }],
  });
  assert.notEqual(added.isError, true);
  const id = added.structuredContent.task.id;
  const before = h.scheduler.get(id);
  const changed = await _execTool(h.scheduler, 'cron_update', { query: id, parameters: { duration: 4 }, references: [] });
  assert.notEqual(changed.isError, true);
  const after = h.scheduler.get(id);
  assert.equal(after.action.mediaModel, before.action.mediaModel);
  assert.equal(after.nextRunAt, before.nextRunAt);
  assert.deepEqual(after.action.parameters, { duration: 4 });
  assert.deepEqual(after.action.references, []);
  const invalid = await _execTool(h.scheduler, 'cron_update', { query: id, name: 'must not persist', parameters: { apiKey: 'fixture-only' } });
  assert.equal(invalid.isError, true);
  assert.deepEqual(h.scheduler.get(id), after);
  assert.equal(h.calls.length, 0, 'creating/editing a schedule must never generate');
});

test('media task validation rejects malformed parameters and missing video selection before persistence', t => {
  const h = fixture(t);
  const base = { enabled: false, schedule: { kind: 'every', everyMs: 60000 }, action: { type: 'video', prompt: 'cube' } };
  assert.equal(h.scheduler.create(base).code, 'INVALID_TASK_CONFIGURATION');
  assert.equal(h.scheduler.create({ ...base, action: { ...base.action, mediaModel: 'p::media::b', parameters: { duration: {} } } }).code, 'INVALID_TASK_CONFIGURATION');
  assert.equal(h.scheduler.create({ ...base, action: { ...base.action, mediaModel: 'p::media::b', references: [''] } }).code, 'INVALID_TASK_CONFIGURATION');
  assert.equal(h.scheduler.list().length, 0);
});


test('recovered media updates its original receipt and history once using the original action snapshot', async t => {
  let submissions = 0, finishes = 0, notifications = 0;
  const h = fixture(t, {
    generateMedia: async () => { submissions += 1; return { ok: false, taskId: 'recovery-media', state: 'download_failed', recoverable: true }; },
    taskRunFinish: () => { finishes += 1; }, notify: () => { notifications += 1; },
  });
  const task = h.create({ prompt: 'Original prompt' });
  const receipt = await h.scheduler.runNow(task.id);
  await completed(h.scheduler, task.id);
  h.scheduler.update(task.id, { action: { ...task.action, prompt: 'Edited future prompt' } });
  const media = { id: 'recovery-media', runId: receipt.runId, source: { type: 'schedule', runId: receipt.runId },
    state: 'completed', mediaKind: 'video', updatedAt: new Date().toISOString(),
    artifacts: [{ path: '/fixture/recovered.mp4', kind: 'video' }] };
  const recovered = h.scheduler.reconcileMediaTask(media);
  assert.equal(recovered.changed, true);
  const run = h.scheduler.runs(task.id)[0];
  assert.equal(run.status, 'ok');
  assert.equal(run.mediaRecovery.previousStatus, 'error');
  assert.equal(h.saved.length, 2, 'recovery replaces the pending turn');
  assert.equal(h.saved[1].turns.length, 1);
  assert.equal(h.saved[1].turns[0].prompt, 'Original prompt');
  assert.equal(h.saved[1].turns[0].runId, receipt.runId);
  assert.deepEqual(h.saved[1].turns[0].resultPaths, ['/fixture/recovered.mp4']);
  const bytes = fs.readFileSync(path.join(h.dir, 'schedules.json'), 'utf8');
  const repeated = h.scheduler.reconcileMediaTask(media);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.result.ok, true);
  assert.equal(fs.readFileSync(path.join(h.dir, 'schedules.json'), 'utf8'), bytes);
  assert.equal(h.saved.length, 2);
  assert.equal(submissions, 1);
  assert.equal(finishes, 1, 'the executor alone finishes the shadow run');
  assert.equal(notifications, 0, 'recovery must not deliver a second notification');
});

test('active media completion belongs to the scheduler executor and unrelated callbacks cannot rewrite it', async t => {
  let release, input;
  const h = fixture(t, { generateMedia: request => { input = request; return new Promise(resolve => { release = resolve; }); } });
  const task = h.create();
  const receipt = await h.scheduler.runNow(task.id);
  const media = { id: 'active-media', source: input.source, state: 'completed', artifacts: [{ path: '/fixture/active.mp4' }] };
  assert.deepEqual(h.scheduler.reconcileMediaTask(media), { handled: true, active: true, changed: false, runId: receipt.runId });
  assert.equal(h.saved.length, 0);
  release({ ok: true, taskId: 'active-media', paths: ['/fixture/active.mp4'], artifacts: media.artifacts });
  await completed(h.scheduler, task.id);
  assert.equal(h.scheduler.reconcileMediaTask(media).changed, false);
  assert.equal(h.scheduler.reconcileMediaTask({ ...media, id: 'wrong-media' }).handled, false);
  assert.equal(h.scheduler.reconcileMediaTask({ ...media, source: { type: 'creation', runId: receipt.runId } }).handled, false);
  assert.equal(h.saved.length, 1);
});

test('a locally stopped run can recover the same remote output without discarding the original stop reason', async t => {
  const h = fixture(t, { generateMedia: async () => ({ ok: false, canceled: true, taskId: 'stopped-media', state: 'stopped', error: 'Application shutdown' }) });
  const task = h.create({}, { saveToHistory: false });
  const receipt = await h.scheduler.runNow(task.id);
  await completed(h.scheduler, task.id);
  const restored = h.scheduler.reconcileMediaTask({ id: 'stopped-media', runId: receipt.runId,
    source: { type: 'schedule', runId: receipt.runId }, state: 'completed', artifacts: [{ path: '/fixture/stopped.mp4' }] });
  assert.equal(restored.changed, true);
  const run = h.scheduler.runs(task.id)[0];
  assert.equal(run.status, 'ok');
  assert.equal(run.mediaRecovery.previousStatus, 'canceled');
  assert.match(run.mediaRecovery.previousError, /Application shutdown/);
  assert.equal(h.saved.length, 0);
});

test('continued media reconciles the original schedule run even when its ledger run ID changed', async t => {
  let submissions = 0;
  const h = fixture(t, { generateMedia: async () => {
    submissions += 1;
    return { ok: false, taskId: 'continued-media', state: 'download_failed', recoverable: true };
  } });
  const task = h.create();
  const receipt = await h.scheduler.runNow(task.id);
  await completed(h.scheduler, task.id);
  const media = { id: 'continued-media', runId: 'new-ledger-continuation',
    source: { type: 'schedule', runId: receipt.runId }, state: 'completed',
    artifacts: [{ path: '/fixture/continued.mp4', kind: 'video' }] };
  const result = h.scheduler.reconcileMediaTask(media);
  assert.equal(result.runId, receipt.runId);
  assert.equal(result.result.ok, true);
  assert.equal(h.scheduler.runs(task.id).length, 1);
  assert.equal(h.scheduler.runs(task.id)[0].runId, receipt.runId);
  assert.equal(h.scheduler.runs(task.id)[0].status, 'ok');
  assert.equal(h.saved.at(-1).turns.length, 1);
  assert.equal(h.saved.at(-1).turns[0].runId, receipt.runId);
  assert.equal(submissions, 1);
  assert.equal(h.scheduler.reconcileMediaTask(media).changed, false);
});

test('scheduler media catalog is read-only, filtered, detached, and never returns connection credentials', async t => {
  const catalog = [
    { routeId: 'one::media::video', bindingId: 'video', providerId: 'one', providerName: 'Gateway',
      modelId: 'arbitrary-video-id', modality: 'video', protocol: 'ark-video', enabled: true, available: true,
      apiKey: 'must-not-escape', credentialRef: 'private-ref', baseUrl: 'https://private.invalid', routeHeaders: { authorization: 'private' },
      capabilities: { operations: ['text_to_video'], defaults: { duration: 4 }, parameters: { duration: { min: 2, max: 10, integer: true } }, references: { max: 0 }, auth: { token: 'private' } } },
    { routeId: 'two::media::image', modality: 'image', enabled: true, available: false, capabilities: {} },
    { routeId: 'three::media::video', modality: 'video', enabled: false, available: true, capabilities: {} },
  ];
  const discoveryCalls = [];
  const h = fixture(t, { listMediaModels: options => { discoveryCalls.push(options); return catalog; } });
  const listed = await h.scheduler.listMediaModels({ modality: 'video' });
  assert.deepEqual(discoveryCalls, [{ modality: 'video' }]);
  assert.deepEqual(listed.map(model => model.routeId), ['one::media::video']);
  assert.deepEqual(listed[0].capabilities.parameters.duration, { min: 2, max: 10, integer: true });
  assert.doesNotMatch(JSON.stringify(listed), /must-not-escape|private|credentialRef|routeHeaders|baseUrl/);
  listed[0].capabilities.defaults.duration = 99;
  assert.equal(catalog[0].capabilities.defaults.duration, 4);
  assert.equal((await h.scheduler.listMediaModels({ includeUnavailable: true })).length, 3);
  await assert.rejects(h.scheduler.listMediaModels({ modality: 'audio' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(h.scheduler.list().length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.saved.length, 0);
});

test('scheduler reports an unavailable media catalog instead of presenting an empty catalog as success', async t => {
  const h = fixture(t);
  await assert.rejects(h.scheduler.listMediaModels(), { code: 'MEDIA_CATALOG_UNAVAILABLE' });
});
