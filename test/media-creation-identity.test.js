'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHistoryStore } = require('../src/main/app/history-store');
const { reconcileMediaTask } = require('../src/main/media/media-task-bridge');
const { compactText } = require('../src/main/tasks/task-event-normalizer');
const { groupItems } = require('../renderer/sidebar-history');
const main = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function section(source, begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, 'production section exists');
  return source.slice(start, finish);
}

for (const mediaKind of ['video', 'image']) {
  test(`${mediaKind} submission records its route and uses its own resource pool`, async () => {
    let handler, record, sent, resource;
    const context = {
      ipcMain: { handle(_channel, callback) { handler = callback; } },
      crypto: { randomUUID: () => 'generated-run' }, assertConversationAvailable() {},
      resolveMediaRequest: opts => ({ model: opts.model, mediaKind }),
      createShadowTaskRun(input) { record = copy(input); return record; }, taskLedger: null,
      TASK_EVENT_EPOCH: 'test-epoch', RUN_STATES: { QUEUED: 'queued' }, compactText: text => text,
      async acquireTaskResource(_id, name) { resource = name; return { signal: null }; },
      releaseTaskResource() {}, updateScheduledShadowPhase() {}, materializeCreationTaskResult() {},
      finishShadowTaskRun() {}, async generateImageCore(input) { sent = copy(input); return { ok: false, mediaKind, error: 'Invalid request' }; }, console,
    };
    vm.runInNewContext(section(main, "ipcMain.handle('image:generate',", '// IPC: 删除"我的创作"'), context);
    const model = 'provider-b::media::binding-seedance';
    const result = await handler({}, { model, mediaKind, prompt: 'A slowly turning shape', resolution: '480p', ratio: '1:1', conversationId: 'creation-b', turnIndex: 1 });
    assert.equal(record.kind, mediaKind); assert.equal(record.metadata.mediaKind, mediaKind);
    assert.equal(record.metadata.model, model); assert.equal(record.execution.resource, mediaKind); assert.equal(resource, mediaKind);
    assert.equal(sent.model, model); assert.equal(sent.resolution, '480p'); assert.equal(sent.ratio, '1:1');
    assert.equal(sent.conversationId, 'creation-b'); assert.equal(sent.turnIndex, 1);
    assert.equal(result.mediaKind, mediaKind); assert.equal(result.error, 'Invalid request');
  });
}

test('video title uses the submitted conversation while another image conversation is visible', async () => {
  const target = { id: 'video-conversation', turns: [{ model: 'gateway-b::media::video', mediaKind: 'video' }] };
  const visible = { id: 'image-conversation', title: 'Keep this title', turns: [{ mediaKind: 'image' }] };
  let titleInput, saved;
  const context = {
    currentCreateConv: visible,
    window: { api: { summarizeTitle: async text => { titleInput = text; return { title: '缓慢旋转的视频' }; },
      history: { load: async id => { assert.equal(id, target.id); return copy(target); }, save: async value => { saved = copy(value); } } } },
    refreshHistoryList: async () => {},
  };
  vm.runInNewContext(section(renderer, 'async function maybeTitleCreateConv(', '// 收集"当前对话里所有结果图"'), context);
  await context.maybeTitleCreateConv('缓慢旋转', target);
  assert.equal(titleInput, '用户想生成的视频:缓慢旋转'); assert.equal(saved.id, target.id);
  assert.equal(saved.turns[0].model, target.turns[0].model); assert.equal(saved.turns[0].mediaKind, 'video');
  assert.equal(visible.title, 'Keep this title');
});

test('legacy image creation without mediaKind retains image title wording', async () => {
  let titleInput;
  const context = { currentCreateConv: null, window: { api: { summarizeTitle: async text => { titleInput = text; return {}; } } } };
  vm.runInNewContext(section(renderer, 'async function maybeTitleCreateConv(', '// 收集"当前对话里所有结果图"'), context);
  await context.maybeTitleCreateConv('静物', { id: 'legacy', turns: [{ model: 'legacy-image' }] });
  assert.equal(titleInput, '用户想生成的图片:静物');
});

test('main history retains authoritative type and video fallback without rewriting the route', () => {
  const conversation = { id: 'creation', kind: 'create', turns: [{ model: 'overseas-gateway::media::video', mediaKind: 'image', parameters: { resolution: '480p', ratio: '1:1' } }] };
  let saved;
  const context = { loadConversation: () => copy(conversation), saveConversation: value => { saved = copy(value); }, compactText: text => text };
  vm.runInNewContext(section(main, 'function materializeCreationTaskResult(', '// IPC: 文生图'), context);
  assert.equal(context.materializeCreationTaskResult({ conversationId: 'creation', turnIndex: 0, runId: 'run-video' }, { ok: false, mediaKind: 'video', taskId: 'task-video' }), true);
  assert.equal(saved.turns[0].error, '视频生成未完成'); assert.equal(saved.turns[0].mediaKind, 'video');
  assert.equal(saved.turns[0].model, conversation.turns[0].model); assert.deepEqual(saved.turns[0].parameters, conversation.turns[0].parameters);
});

test('renderer completion retains service media type and provider route in history', async () => {
  const conversation = { id: 'creation', turns: [{ model: 'gateway-b::media::video', mediaKind: 'image' }] };
  let saved;
  const context = {
    window: { api: { history: { load: async () => copy(conversation), save: async value => { saved = copy(value); } } } },
    currentCreateConv: null, activeView: 'chat', cvSyncGenerateBtn() {}, refreshHistoryList() {},
  };
  vm.runInNewContext(section(renderer, 'async function cvFinishTurn(', '// 给创作会话生成简短标题'), context);
  await context.cvFinishTurn('creation', 0, 'prompt', { ok: false, error: 'Invalid request', mediaKind: 'video', taskId: 'task-video' }, null);
  assert.equal(saved.turns[0].mediaKind, 'video'); assert.equal(saved.turns[0].model, conversation.turns[0].model);
  assert.equal(saved.turns[0].error, 'Invalid request'); assert.equal(saved.turns[0].mediaTaskId, 'task-video');
});

function mediaHistory(t, record) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-media-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const open = () => createHistoryStore({ getUserDataDir: () => directory, recoverLegacyOutput: value => value });
  const initial = open();
  initial.writeHistoryIndex([]);
  initial.persistConversationRecord(record);
  return task => {
    const history = open();
    let writes = 0;
    const context = { loadConversation: history.loadConversation, compactText,
      saveConversation: value => { writes++; history.persistConversationRecord(value); } };
    vm.runInNewContext(section(main, 'function materializeCreationTaskResult(', '// IPC: 文生图'), context);
    reconcileMediaTask(task, { materialize: context.materializeCreationTaskResult });
    return { writes, record: history.loadConversation(record.id), items: history.readHistoryIndex() };
  };
}

const submittedAt = new Date(2026, 9, 26, 23, 59).toISOString();
const finishedAt = new Date(2026, 9, 27, 0, 1).toISOString();
const restartDay = new Date(2026, 10, 9, 12);

for (const [state, mediaKind, results, error] of [
  ['completed', 'video', ['result.mp4']],
  ['failed', 'video', [], 'provider error'],
  ['stopped', 'image', [], '已停止本地等待'],
  ['download_failed', 'image', ['first.png'], 'partial download'],
]) {
  test(`replaying a ${state} ${mediaKind} task across two restarts leaves history at its original date`, t => {
    const task = { id: 'task-a', runId: 'run-a', conversationId: 'creation', turnIndex: 0, state, mediaKind,
      artifacts: results.map(path => ({ path })), updatedAt: finishedAt };
    if (error && state !== 'stopped') task.error = { message: error };
    const turn = { runId: task.runId, mediaTaskId: task.id, mediaKind, resultPaths: results };
    if (error) turn.error = error;
    const record = { id: task.conversationId, kind: 'create', createdAt: submittedAt, updatedAt: finishedAt, turns: [turn] };
    const restart = mediaHistory(t, record);
    for (let i = 0; i < 2; i++) {
      const restored = restart(task);
      assert.equal(restored.writes, 0);
      assert.deepEqual(restored.record, record);
      assert.equal(restored.items[0].updatedAt, finishedAt);
      assert.equal(groupItems(restored.items, restartDay)[0].id, 'month');
    }
  });
}

test('missing video result is dated at genuine completion across midnight, including on delayed replay', t => {
  const task = { id: 'run-a', runId: 'run-a', conversationId: 'creation', turnIndex: 0, state: 'completed',
    mediaKind: 'video', updatedAt: finishedAt, artifacts: [{ path: 'result.mp4' }] };
  const record = { id: task.conversationId, kind: 'create', createdAt: submittedAt, updatedAt: submittedAt,
    turns: [{ runId: task.runId, resultPaths: [] }] };
  const restart = mediaHistory(t, record);
  assert.equal(groupItems([record], new Date(finishedAt))[0].id, 'yesterday');
  const restored = restart(task);
  assert.equal(restored.writes, 1);
  assert.deepEqual(restored.record.turns[0].resultPaths, ['result.mp4']);
  assert.equal(restored.record.updatedAt, finishedAt);
  assert.equal(groupItems(restored.items, new Date(finishedAt))[0].id, 'today');
  assert.equal(groupItems(restored.items, restartDay)[0].id, 'month');
  const again = restart(task);
  assert.equal(again.writes, 0);
  assert.deepEqual(again.record, restored.record);
});

test('backfilling an older creation turn preserves a later turn and its activity date', t => {
  const laterAt = new Date(2026, 10, 8, 13).toISOString();
  const task = { id: 'run-a', runId: 'run-a', conversationId: 'creation', turnIndex: 0, state: 'completed',
    mediaKind: 'video', updatedAt: finishedAt, artifacts: [{ path: 'result.mp4' }] };
  const later = { runId: 'run-b', prompt: 'Later turn', ts: laterAt, resultPaths: ['later.png'] };
  const restart = mediaHistory(t, { id: task.conversationId, kind: 'create', createdAt: submittedAt,
    updatedAt: laterAt, turns: [{ runId: task.runId, resultPaths: [] }, later] });
  const restored = restart(task);
  assert.equal(restored.writes, 1);
  assert.deepEqual(restored.record.turns[0].resultPaths, ['result.mp4']);
  assert.deepEqual(restored.record.turns[1], later);
  assert.equal(restored.record.updatedAt, laterAt);
  assert.equal(groupItems(restored.items, restartDay)[0].id, 'yesterday');
});
