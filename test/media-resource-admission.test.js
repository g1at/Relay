'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { TaskLedger } = require('../src/main/tasks/task-ledger');
const { TaskOrchestrator, inferResource } = require('../src/main/tasks/task-orchestrator');
const { RUN_STATES, isTerminalState } = require('../src/main/tasks/task-protocol');
const { MediaService } = require('../src/main/media/media-service');
const { reconcileMediaTask } = require('../src/main/media/media-task-bridge');
const main = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64');
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const copy = value => JSON.parse(JSON.stringify(value));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function section(begin, end) {
  const start = main.indexOf(begin), finish = main.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, `production section exists: ${begin}`);
  return main.slice(start, finish);
}
async function until(predicate, message = 'condition not reached') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(message);
}
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function waitGate(item, signal) {
  if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
  let abort;
  const aborted = new Promise((_resolve, reject) => { abort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); signal?.addEventListener('abort', abort, { once: true }); });
  try { await Promise.race([item.promise, aborted]); } finally { signal?.removeEventListener('abort', abort); }
}
function runtime(kind) {
  return { routeId: `fixture::media::${kind}`, providerId: 'fixture', bindingId: kind,
    protocol: kind === 'video' ? 'ark-video' : 'openai-images', modality: kind,
    // Deliberately misleading names prove resource selection uses the protocol.
    modelId: kind === 'video' ? 'model-called-image' : 'model-called-video',
    baseUrl: 'https://fixture.invalid', auth: { mode: 'none' },
    capabilities: { operations: [kind === 'video' ? 'text_to_video' : 'text_to_image'], references: { max: 0 }, parameters: {} } };
}
function harness(t, poolLimits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-media-resource-'));
  const ledger = new TaskLedger({ rootDir: path.join(dir, 'ledger'), logger: { warn() {} } });
  const orchestrator = new TaskOrchestrator({ ledger, poolLimits, healthCheckIntervalMs: 0, logger: { warn() {} } });
  orchestrator.start({ recover: false });
  const runtimes = new Map(['image', 'video'].map(kind => { const value = runtime(kind); return [value.routeId, value]; }));
  const calls = [], gates = new Map(), pending = [], releases = new Map(), handlers = new Map();
  let service;
  const finish = (id, ok, details = {}) => {
    const run = ledger.get(id);
    if (run && !isTerminalState(run.state)) ledger.terminal(id, details.status || (ok ? RUN_STATES.SUCCEEDED : RUN_STATES.FAILED), { result: copy(details) });
  };
  const context = vm.createContext({
    crypto, console, RUN_STATES, isTerminalState,
    // VM object prototypes differ; IPC/main normally share the ledger's realm.
    taskLedger: { get: id => ledger.get(id), update: (id, patch) => ledger.update(id, copy(patch)) }, taskOrchestrator: orchestrator,
    taskResourceLeases: new Map(), TASK_EVENT_EPOCH: 'fixture-epoch',
    require: id => require(path.join(__dirname, '../src/main', id)),
    providerStore: { getMediaRuntime: route => runtimes.get(route), listMediaModels: ({ modality } = {}) => [...runtimes.values()].filter(value => !modality || value.modality === modality).map(value => ({ ...value, available: true })) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertConversationAvailable() {}, compactText: value => value,
    createShadowTaskRun: input => { try { return ledger.create(copy(input)); } catch (error) { if (ledger.get(input.runId)) return null; throw error; } },
    materializeCreationTaskResult() {}, finishShadowTaskRun: finish,
    updateScheduledShadowPhase: id => { const run = ledger.get(id); if (run && !isTerminalState(run.state)) ledger.update(id, { state: RUN_STATES.RUNNING }); },
    resolveExecutionWorkspace: () => ({ cwd: dir }), waitForCheckpointUnlock: async () => true,
    getMediaService: () => service,
  });
  vm.runInContext(section('async function acquireTaskResource(', 'let startupTaskLedgerRetentionScheduled'), context);
  const release = context.releaseTaskResource;
  context.releaseTaskResource = id => { const result = release(id); if (result) releases.set(id, (releases.get(id) || 0) + 1); return result; };
  vm.runInContext(section('function resolveMediaRequest(', "ipcMain.handle('image:getConfig'"), context);
  vm.runInContext(section("for (const method of ['list', 'get', 'resume', 'stop', 'retryDownload'])", 'async function generateImageCore('), context);
  vm.runInContext(section('async function generateImageCore(', '// renderer 可能在付费图片请求'), context);
  vm.runInContext(section("ipcMain.handle('image:generate',", '// IPC: 删除"我的创作"'), context);
  vm.runInContext(section('function startScheduledShadowRun(', 'function updateScheduledShadowPhase('), context);
  vm.runInContext(`this.schedulerOptions = {${section('taskRunAcquire: async (runId, actionType)', 'taskRunRelease: releaseTaskResource,')}}`, context);
  vm.runInContext(section('function restoreMediaTasks()', 'function initScheduler()'), context);
  service = new MediaService({ userDataDir: dir, resolveRuntime: route => runtimes.get(route), pollIntervalMs: 0, maxPollAttempts: 3,
    onChanged: task => {
      reconcileMediaTask(task, { ledger, finish });
      if (task.runId && ledger.get(task.runId)?.metadata?.mediaRecoveryOnly) orchestrator.dispatch();
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      if (url.startsWith('https://asset.invalid/')) return new Response(MP4);
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        const id = body.prompt || body.content.find(item => item.type === 'text').text;
        const item = gates.get(id); assert.ok(item, 'request belongs to this isolated fixture');
        item.posts++;
        if (body.model === 'model-called-image') return json({ id });
        await waitGate(item, init.signal);
        return item.fail ? json({ error: { message: 'Fixture rejection', code: 'bad_request' } }, 400) : json({ data: [{ b64_json: PNG.toString('base64') }] });
      }
      const id = new URL(url).pathname.split('/').at(-1), item = gates.get(id);
      assert.ok(item, 'poll uses the original fixture handle'); item.polls++;
      await waitGate(item, init.signal);
      if (item.remoteRunning) return json({ id, status: 'running' });
      return json({ id, status: 'succeeded', content: { video_url: `https://asset.invalid/${id}` } });
    },
  });
  function submit(kind, extra = {}) {
    const id = crypto.randomUUID(), item = { ...gate(), posts: 0, polls: 0, fail: false };
    gates.set(id, item);
    const promise = handlers.get('image:generate')({}, { model: `fixture::media::${kind}`, mediaKind: kind, prompt: id, runId: id, conversationId: `conversation-${id}`, ...extra });
    pending.push(promise); return { id, item, promise };
  }
  t.after(async () => {
    orchestrator.shutdown();
    for (const item of gates.values()) item.resolve();
    for (const id of service.running.keys()) await service.stop(id);
    await Promise.allSettled([...pending, ...service.running.values()]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ledger, orchestrator, runtimes, context, handlers, service, gates, calls, releases, pending, submit };
}

test('long videos do not block images; per-kind limits queue and release once on completion, failure and stop', async t => {
  const f = harness(t);
  const videos = [f.submit('video'), f.submit('video'), f.submit('video')];
  const images = [f.submit('image'), f.submit('image'), f.submit('image'), f.submit('image')];
  await until(() => videos[1].item.polls === 1 && images[2].item.posts === 1);
  assert.equal(videos[2].item.posts, 0); assert.equal(images[3].item.posts, 0);
  assert.equal(f.orchestrator.getStats().byResource.video.active, 2);
  assert.equal(f.orchestrator.getStats().byResource.image.active, 3);
  images[0].item.fail = true; images[0].item.resolve();
  assert.equal((await images[0].promise).ok, false);
  await until(() => images[3].item.posts === 1);
  assert.equal(videos[2].item.posts, 0, 'image failure cannot release a video slot');
  await f.handlers.get('media:stop')({}, images[2].id); await images[2].promise;
  assert.equal(f.ledger.get(images[2].id).state, RUN_STATES.WAITING_USER);
  const replacement = f.submit('image');
  await until(() => replacement.item.posts === 1, 'stopped WAITING_USER record cannot retain a phantom slot');
  videos[0].item.resolve(); assert.equal((await videos[0].promise).ok, true);
  await until(() => videos[2].item.posts === 1);
  for (const item of f.gates.values()) item.resolve();
  await Promise.all(f.pending);
  for (const task of [...videos, ...images, replacement]) assert.equal(f.releases.get(task.id), 1);
  assert.equal(f.context.taskResourceLeases.size, 0); assert.equal(f.orchestrator.externalActive.size, 0);
  assert.equal(f.orchestrator.getStats().byResource.image.active, 0); assert.equal(f.orchestrator.getStats().byResource.video.active, 0);
});

test('interactive and scheduled media use resolved protocol modality, not input hint or model name', async t => {
  const f = harness(t);
  const video = f.submit('video', { mediaKind: 'image' });
  await until(() => video.item.posts === 1);
  assert.equal(f.ledger.get(video.id).execution.resource, 'video'); assert.equal(f.ledger.get(video.id).kind, 'video');
  const id = f.context.startScheduledShadowRun({ task: { id: 'schedule', name: 'Scheduled video', action: { type: 'image', mediaModel: 'fixture::media::video' } } });
  assert.equal(f.ledger.get(id).kind, 'scheduled_video');
  const lease = await f.context.schedulerOptions.taskRunAcquire(id, 'image');
  assert.equal(lease.resource, 'video');
  f.ledger.terminal(id, RUN_STATES.CANCELED); f.context.releaseTaskResource(id);
  assert.equal(inferResource({ kind: 'scheduled_video' }), 'video');
  assert.equal(inferResource({ kind: 'video', execution: { resource: 'custom-pool' } }), 'custom-pool');
  video.item.resolve(); assert.equal((await video.promise).ok, true);
});

test('explicit pool limits survive defaults and unrelated settings changes; queued cancellation does not submit', async t => {
  const f = harness(t, { image: 1, video: 1 });
  f.orchestrator.setPoolLimits({ claude: 4 });
  assert.equal(f.orchestrator.poolLimits.image, 1); assert.equal(f.orchestrator.poolLimits.video, 1);
  const image = f.submit('image'), queuedImage = f.submit('image'), video = f.submit('video'), queuedVideo = f.submit('video');
  await until(() => image.item.posts === 1 && video.item.polls === 1);
  assert.equal(queuedImage.item.posts, 0); assert.equal(queuedVideo.item.posts, 0);
  f.orchestrator.cancel(queuedImage.id); assert.equal((await queuedImage.promise).canceled, true);
  assert.equal(queuedImage.item.posts, 0); assert.equal(f.releases.has(queuedImage.id), false);
  image.item.resolve(); video.item.resolve(); await Promise.all([image.promise, video.promise]);
  await until(() => queuedVideo.item.posts === 1); queuedVideo.item.resolve(); await queuedVideo.promise;
  for (const task of [image, video, queuedVideo]) assert.equal(f.releases.get(task.id), 1);
});

test('resume queries the accepted handle without another POST or a new generation slot', async t => {
  const f = harness(t, { video: 1 });
  const video = f.submit('video'); await until(() => video.item.polls === 1);
  await f.handlers.get('media:stop')({}, video.id); await video.promise;
  assert.equal(f.orchestrator.getStats().byResource.video.active, 0);
  await f.handlers.get('media:resume')({}, video.id);
  await until(() => video.item.polls === 2);
  assert.equal(video.item.posts, 1); assert.equal(f.ledger.get(video.id).metadata.mediaRecoveryOnly, true);
  assert.equal(f.ledger.get(video.id).execution.resource, 'video'); assert.equal(f.orchestrator.getStats().byResource.video.active, 0);
  const another = f.submit('video'); await until(() => another.item.posts === 1);
  const sameConversation = f.submit('image', { conversationId: `conversation-${video.id}` });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sameConversation.item.posts, 0, 'active recovery keeps the conversation writer exclusive');
  video.item.resolve(); another.item.resolve();
  assert.equal((await f.service.wait(video.id)).state, 'completed'); assert.equal((await another.promise).ok, true);
  await until(() => sameConversation.item.posts === 1, 'recovery completion admits the waiting conversation');
  sameConversation.item.resolve(); assert.equal((await sameConversation.promise).ok, true);
  assert.equal(video.item.posts, 1); assert.equal(f.releases.get(video.id), 1);
});

test('changing a queued binding to another modality fails before POST and releases its original pool slot', async t => {
  const f = harness(t, { video: 1 });
  const first = f.submit('video'), queued = f.submit('video');
  await until(() => first.item.polls === 1); assert.equal(queued.item.posts, 0);
  f.runtimes.set('fixture::media::video', { ...runtime('image'), routeId: 'fixture::media::video' });
  first.item.resolve(); await first.promise;
  const result = await queued.promise;
  assert.equal(result.code, 'MEDIA_CONFIGURATION_CHANGED'); assert.equal(queued.item.posts, 0);
  assert.equal(f.ledger.get(queued.id).state, RUN_STATES.FAILED);
  assert.equal(f.releases.get(queued.id), 1); assert.equal(f.orchestrator.getStats().byResource.video.active, 0);
});

test('startup recovery repairs old video resource identity and only queries its existing remote handle', async t => {
  const f = harness(t, { video: 1 });
  f.service.maxPollAttempts = 1;
  const video = f.submit('video'); await until(() => video.item.polls === 1);
  video.item.remoteRunning = true; video.item.resolve();
  assert.equal((await video.promise).recoverable, true);
  assert.equal(f.ledger.get(video.id).state, RUN_STATES.WAITING_USER);
  f.ledger.update(video.id, { execution: { resource: 'image' }, metadata: { orchestration: { resource: 'image' } } });
  Object.assign(video.item, gate(), { remoteRunning: false });
  f.context.restoreMediaTasks(); await until(() => video.item.polls === 2);
  const restored = f.ledger.get(video.id);
  assert.equal(restored.execution.resource, 'video'); assert.equal(restored.metadata.orchestration.resource, 'video');
  assert.equal(restored.metadata.mediaRecoveryOnly, true); assert.equal(video.item.posts, 1);
  assert.equal(f.orchestrator.getStats().byResource.video.active, 0);
  const another = f.submit('video'); await until(() => another.item.posts === 1);
  video.item.resolve(); another.item.resolve(); await f.service.wait(video.id); await another.promise;
  assert.equal(video.item.posts, 1);
});

test('resuming an accepted task after its old run ended creates a video continuation without POST or lease', async t => {
  const f = harness(t, { video: 1 });
  const video = f.submit('video'); await until(() => video.item.polls === 1);
  await f.handlers.get('media:stop')({}, video.id); await video.promise;
  f.ledger.terminal(video.id, RUN_STATES.CANCELED);
  const resumed = await f.handlers.get('media:resume')({}, video.id);
  const continuation = f.ledger.get(resumed.runId);
  assert.notEqual(resumed.runId, video.id); assert.equal(continuation.kind, 'video');
  assert.equal(continuation.execution.resource, 'video'); assert.equal(continuation.metadata.mediaRecoveryOnly, true);
  assert.equal(continuation.recovery.continuationOf, video.id);
  await until(() => video.item.polls === 2); assert.equal(video.item.posts, 1);
  assert.equal(f.context.taskResourceLeases.size, 0); assert.equal(f.orchestrator.getStats().byResource.video.active, 0);
  video.item.resolve(); await f.service.wait(video.id);
  assert.equal(f.ledger.get(resumed.runId).state, RUN_STATES.SUCCEEDED);
});
