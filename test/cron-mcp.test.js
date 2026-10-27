'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCronMcpServer, CRON_MCP_TOOL_TIMEOUT_MS, _execTool } = require('../src/main/scheduling/cron-mcp');

// The adapter receives the same service as IPC. This fake intentionally returns live
// objects, so failed MCP validation cannot hide accidental in-place mutation.
function schedulerService() {
  const state = { tasks: [], runs: [] };
  const calls = [];
  let sequence = 0;
  const service = {
    list() { calls.push(['list']); return state.tasks; },
    create(input) {
      calls.push(['create', structuredClone(input)]);
      const task = { ...structuredClone(input), id: `task-${++sequence}`, nextRunAt: '2030-01-01T00:00:00.000Z', runCount: 0 };
      state.tasks.push(task);
      return { ok: true, id: task.id, task };
    },
    update(id, patch) {
      calls.push(['update', id, structuredClone(patch)]);
      const index = state.tasks.findIndex((task) => task.id === id);
      if (index < 0) return { ok: false, code: 'TASK_NOT_FOUND', error: '任务不存在' };
      const task = state.tasks[index];
      const merged = {
        ...task, ...structuredClone(patch),
        schedule: { ...task.schedule, ...patch.schedule },
        action: { ...task.action, ...patch.action },
      };
      state.tasks[index] = merged;
      return { ok: true, task: merged };
    },
    remove(id) { calls.push(['remove', id]); state.tasks = state.tasks.filter((task) => task.id !== id); return { ok: true }; },
    toggle(id, enabled) { calls.push(['toggle', id, enabled]); state.tasks.find((task) => task.id === id).enabled = enabled; return { ok: true }; },
    runs(id) { calls.push(['runs', id]); return state.runs.filter((run) => run.taskId === id); },
    runNow(id) { calls.push(['runNow', id]); return { ok: true, status: 'accepted', code: 'TASK_STARTED', taskId: id, runId: 'run-1' }; },
  };
  return { service, state, calls };
}
function responseText(result) { return result.content.map((item) => item.text || '').join('\n'); }
async function successful(service, name, args) {
  const result = await _execTool(service, name, args);
  assert.notEqual(result.isError, true, responseText(result));
  return result;
}
async function rejected(service, name, args, expected) {
  const result = await _execTool(service, name, args);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.match(responseText(result), expected);
  return result;
}
async function add(service, args = {}) {
  return successful(service, 'cron_add', { name: 'daily report', prompt: 'write report', everyMs: 60000, ...args });
}
function serverFor(service) {
  const schema = () => ({ optional() { return this; }, describe() { return this; } });
  return createCronMcpServer({
    createSdkMcpServer: (options) => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    z: { string: schema, number: schema, boolean: schema, object: schema, array: schema, record: schema, union: schema }, scheduler: service,
  });
}

test('cron_media_models is registered and discovers exact routes and capabilities without generating or exposing credentials', async () => {
  const { service, calls } = schedulerService();
  service.listMediaModels = async options => {
    calls.push(['listMediaModels', options]);
    return [
      { routeId: 'gateway::media::video', modelId: 'new-video-version', modality: 'video', protocol: 'dashscope-video', enabled: true, available: true,
        apiKey: 'do-not-expose', credentialRef: 'private-ref', routeHeaders: { token: 'private' },
        capabilities: { operations: ['image_to_video'], parameters: { duration: { min: 2, max: 2, integer: true } }, references: { required: true, max: 1, roles: ['first_frame'] } } },
      { routeId: 'gateway::media::image', modality: 'image', enabled: true, available: true, capabilities: {} },
      { routeId: 'disabled::media::video', modality: 'video', enabled: false, available: true, capabilities: {} },
    ];
  };
  const tool = serverFor(service).tools.find(item => item.name === 'cron_media_models');
  assert.ok(tool);
  const result = await tool.handler({ modality: 'video' });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.models.length, 1);
  const model = result.structuredContent.models[0];
  assert.equal(model.routeId, 'gateway::media::video');
  assert.deepEqual(model.capabilities.references, { required: true, max: 1, roles: ['first_frame'] });
  assert.doesNotMatch(JSON.stringify(result), /do-not-expose|private|credentialRef|routeHeaders/);
  assert.deepEqual(calls, [['listMediaModels', { modality: 'video', includeUnavailable: false }]]);
  const all = await successful(service, 'cron_media_models', { includeUnavailable: true });
  assert.equal(all.structuredContent.models.length, 3);
});

test('cron_media_models distinguishes empty configured models from unavailable or invalid catalog requests', async () => {
  const { service, calls } = schedulerService();
  assert.equal((await rejected(service, 'cron_media_models', {}, /尚未就绪/)).structuredContent.code, 'MEDIA_CATALOG_UNAVAILABLE');
  service.listMediaModels = () => [];
  assert.deepEqual((await successful(service, 'cron_media_models', {})).structuredContent, { ok: true, models: [] });
  await rejected(service, 'cron_media_models', { modality: 'audio' }, /image 或 video/);
  await rejected(service, 'cron_media_models', { includeUnavailable: 'yes' }, /布尔值/);
  service.listMediaModels = () => null;
  assert.equal((await rejected(service, 'cron_media_models', {}, /格式无效/)).structuredContent.code, 'MEDIA_CATALOG_UNAVAILABLE');
  assert.equal(calls.length, 0);
});

test('cron MCP creates through scheduler and preserves catchUp and Agent configuration', async () => {
  const { service, state, calls } = schedulerService();
  const result = await add(service, { catchUp: false, mode: 'agent', agentName: 'writer' });
  assert.match(responseText(result), /已创建/);
  assert.equal(calls.filter(([method]) => method === 'create').length, 1);
  assert.equal(state.tasks[0].catchUp, false);
  assert.equal(state.tasks[0].action.mode, 'agent');
  assert.equal(state.tasks[0].action.agentName, 'writer');
  assert.equal(result.structuredContent.task.id, state.tasks[0].id);
  assert.equal(result.structuredContent.task.nextRunAt, state.tasks[0].nextRunAt);
  const view = JSON.parse(responseText(await successful(service, 'cron_get', { query: 'daily report' })));
  assert.equal(view.catchUp, false);
  assert.equal(view.mode, 'agent');
  assert.equal(view.agentName, 'writer');
});

test('cron MCP defaults catchUp=true and rejected Agent edits leave returned objects unchanged', async () => {
  const { service, state, calls } = schedulerService();
  await add(service);
  assert.equal(state.tasks[0].catchUp, true);
  await successful(service, 'cron_update', { query: 'daily report', catchUp: false });
  assert.equal(state.tasks[0].catchUp, false);
  const before = structuredClone(state);
  const callCount = calls.filter(([method]) => method === 'update').length;
  await rejected(service, 'cron_update', { query: 'daily report', name: 'must not persist', mode: 'agent' }, /agentName/);
  assert.deepEqual(state, before);
  assert.equal(calls.filter(([method]) => method === 'update').length, callCount);
});

test('cron MCP rejects invalid cron or too-short intervals before calling scheduler', async () => {
  const { service, state, calls } = schedulerService();
  await rejected(service, 'cron_add', { name: 'invalid', prompt: 'x', cron: '99 9 * * *' }, /调度无效/);
  assert.equal(state.tasks.length, 0);
  assert.equal(calls.some(([method]) => method === 'create'), false);
  await add(service);
  await rejected(service, 'cron_update', { query: 'daily report', everyMs: 500 }, /调度无效/);
  assert.equal(state.tasks[0].schedule.everyMs, 60000);
});

test('cron MCP creates command tasks explicitly or by inference and keeps working directory', async () => {
  const { service, state } = schedulerService();
  await rejected(service, 'cron_add', { name: 'empty', everyMs: 60000, type: 'command' }, /缺少命令脚本/);
  await add(service, { type: ' CoMmAnD ', prompt: 'Write-Output 1', workingDir: 'C:\\Automation' });
  assert.equal(state.tasks[0].action.type, 'command');
  assert.equal(state.tasks[0].action.command, 'Write-Output 1');
  assert.equal(state.tasks[0].action.workingDir, 'C:\\Automation');
  assert.equal(Object.hasOwn(state.tasks[0].action, 'prompt'), false);
  await add(service, { name: 'inferred', command: 'Write-Output 2' });
  assert.equal(state.tasks[1].action.type, 'command');
  assert.equal(state.tasks[1].action.command, 'Write-Output 2');
  const view = JSON.parse(responseText(await successful(service, 'cron_get', { query: state.tasks[0].id })));
  assert.equal(view.type, 'command');
  assert.equal(view.prompt, 'Write-Output 1');
  assert.equal(view.command, 'Write-Output 1');
});

test('cron MCP rejects unknown or conflicting types without submitting a write', async () => {
  const { service, state, calls } = schedulerService();
  await rejected(service, 'cron_add', { name: 'bad', command: 'Write-Output 0', everyMs: 60000, type: 'shell' }, /未知任务类型/);
  await rejected(service, 'cron_add', { name: 'bad', command: 'Write-Output 0', everyMs: 60000, type: ' CHAT ' }, /command 字段只能用于/);
  assert.equal(state.tasks.length, 0);
  assert.equal(calls.some(([method]) => method === 'create'), false);
});

test('cron MCP updates command content via prompt or command using only a sparse scheduler patch', async () => {
  const { service, state, calls } = schedulerService();
  await add(service, { type: 'command', command: 'Write-Output 1' });
  const id = state.tasks[0].id;
  state.tasks[0].lastStatus = 'running';
  state.tasks[0].runCount = 9;
  await successful(service, 'cron_update', { query: id, prompt: 'Write-Output 2', workingDir: 'D:\\Jobs' });
  assert.deepEqual(calls.find(([method]) => method === 'update')[2], {
    action: { command: 'Write-Output 2', workingDir: 'D:\\Jobs' },
  });
  assert.equal(state.tasks[0].action.command, 'Write-Output 2');
  assert.equal(state.tasks[0].action.type, 'command');
  await successful(service, 'cron_update', { query: id, command: 'Write-Output 3', workingDir: '' });
  assert.equal(state.tasks[0].action.command, 'Write-Output 3');
  assert.equal(state.tasks[0].action.workingDir, null);
  assert.equal(state.tasks[0].runCount, 9);
  assert.equal(state.tasks[0].lastStatus, 'running');
});

test('cron MCP can explicitly convert legacy chat and image tasks to command', async () => {
  const { service, state } = schedulerService();
  await add(service, { prompt: 'Write-Output legacy', workingDir: 'C:\\Legacy' });
  await add(service, { name: 'image task', type: 'image', prompt: 'draw image' });
  await successful(service, 'cron_update', { query: 'daily report', type: ' COMMAND ' });
  assert.equal(state.tasks[0].action.type, 'command');
  assert.equal(state.tasks[0].action.command, 'Write-Output legacy');
  assert.equal(state.tasks[0].action.workingDir, 'C:\\Legacy');
  assert.equal(state.tasks[0].action.prompt, '');
  assert.equal(state.tasks[0].action.sessionRef, null);
  await successful(service, 'cron_update', { query: 'image task', type: 'command', prompt: 'Write-Output prompt', command: 'Write-Output command' });
  assert.equal(state.tasks[1].action.type, 'command');
  assert.equal(state.tasks[1].action.command, 'Write-Output command');
});

test('cron MCP rejects invalid conversions and does not mutate objects supplied by scheduler', async () => {
  const { service, state, calls } = schedulerService();
  await add(service);
  state.tasks[0].action.prompt = '';
  const before = structuredClone(state);
  await rejected(service, 'cron_update', { query: 'daily report', name: 'must not persist', type: 'command' }, /缺少命令脚本/);
  await rejected(service, 'cron_update', { query: 'daily report', name: 'must not persist', type: 'shell' }, /未知任务类型/);
  await rejected(service, 'cron_update', { query: 'daily report', command: 'Write-Output blocked' }, /同时指定 type=command/);
  assert.deepEqual(state, before);
  assert.equal(calls.some(([method]) => method === 'update'), false);
});

test('cron MCP preserves chat and image content updates and original timezone', async () => {
  const { service, state, calls } = schedulerService();
  await add(service, { cron: '0 9 * * *', tz: 'America/New_York' });
  await add(service, { name: 'image task', type: 'image', prompt: 'old image' });
  await successful(service, 'cron_update', { query: 'daily report', prompt: 'new chat', workingDir: 'C:\\Chat', cron: '0 10 * * *' });
  await successful(service, 'cron_update', { query: 'image task', prompt: 'new image' });
  assert.equal(state.tasks[0].action.prompt, 'new chat');
  assert.equal(state.tasks[0].action.workingDir, 'C:\\Chat');
  assert.equal(state.tasks[0].schedule.tz, 'America/New_York');
  assert.deepEqual(calls.find(([method]) => method === 'update')[2].schedule, { kind: 'cron', cron: '0 10 * * *' });
  assert.equal(state.tasks[1].action.prompt, 'new image');
  const before = structuredClone(state);
  await rejected(service, 'cron_update', { query: 'image task', name: 'must not persist', command: 'Write-Output wrong' }, /只有命令任务/);
  assert.deepEqual(state, before);
});

test('cron MCP forwards timezone-only edits without replacing schedule or runtime metadata', async () => {
  const { service, state, calls } = schedulerService();
  await add(service, { cron: '0 9 * * *', tz: 'UTC' });
  const nextRunAt = state.tasks[0].nextRunAt;
  await successful(service, 'cron_update', { query: 'daily report', tz: 'Asia/Shanghai' });
  assert.deepEqual(calls.find(([method]) => method === 'update')[2], { schedule: { tz: 'Asia/Shanghai' } });
  assert.equal(state.tasks[0].schedule.cron, '0 9 * * *');
  assert.equal(state.tasks[0].nextRunAt, nextRunAt, 'scheduler owns rescheduling; the MCP adapter must not overwrite it');
});

test('cron MCP list, toggle, remove, and history all use scheduler service', async () => {
  const { service, state, calls } = schedulerService();
  await add(service);
  const id = state.tasks[0].id;
  await successful(service, 'cron_toggle', { query: id, enabled: false });
  const list = await successful(service, 'cron_list', { includeDisabled: false });
  assert.match(responseText(list), /没有任何/);
  state.runs.push({ id: 'run-7', taskId: id, at: '2030-01-01T00:00:00.000Z', status: 'skipped', scheduledFor: '2030-01-01T00:00:00.000Z', reason: 'already_running', trigger: 'scheduled', summary: 'previous run still running' });
  const runs = JSON.parse(responseText(await successful(service, 'cron_runs', { query: id })));
  assert.equal(runs[0].id, 'run-7');
  assert.equal(runs[0].reason, 'already_running');
  assert.equal(runs[0].scheduledFor, state.runs[0].scheduledFor);
  assert.equal(runs[0].trigger, 'scheduled');
  await successful(service, 'cron_remove', { query: id });
  assert.equal(state.tasks.length, 0);
  assert.ok(calls.some(([method, taskId, enabled]) => method === 'toggle' && taskId === id && enabled === false));
  assert.ok(calls.some(([method, taskId]) => method === 'runs' && taskId === id));
  assert.ok(calls.some(([method, taskId]) => method === 'remove' && taskId === id));
});

for (const status of ['accepted', 'queued', 'already_running', 'failed']) {
  test(`cron MCP returns truthful ${status} receipt with runId and MCP error status`, async () => {
    const { service, state } = schedulerService();
    await add(service);
    const id = state.tasks[0].id;
    const receipt = {
      ok: ['accepted', 'queued'].includes(status), status,
      code: status === 'already_running' ? 'TASK_RUNNING' : status === 'failed' ? 'TASK_START_FAILED' : 'TASK_STARTED',
      taskId: id, ...(status === 'failed' ? { error: 'execution unavailable' } : { runId: 'run-receipt' }),
    };
    service.runNow = async (taskId) => { assert.equal(taskId, id); return receipt; };
    const before = structuredClone(state);
    const result = await _execTool(service, 'cron_run', { query: id });
    assert.deepEqual(result.structuredContent, receipt);
    assert.deepEqual(JSON.parse(responseText(result)), receipt);
    assert.equal(result.isError === true, !receipt.ok);
    assert.deepEqual(state, before, 'run requests must never write a runNowAt marker');
    assert.doesNotMatch(responseText(result), /已触发|执行成功|已完成/);
  });
}

test('cron MCP reports unavailable, rejected, thrown, and invalid receipt errors to the caller', async () => {
  const { service } = schedulerService();
  const unavailable = await rejected(null, 'cron_list', {}, /尚未就绪/);
  assert.equal(unavailable.structuredContent.code, 'SCHEDULER_UNAVAILABLE');
  service.create = () => ({ ok: false, code: 'STORE_READ_FAILED', error: '读取定时任务失败' });
  const createFailure = await rejected(service, 'cron_add', { name: 'task', prompt: 'x', everyMs: 60000 }, /读取定时任务失败/);
  assert.equal(createFailure.structuredContent.code, 'STORE_READ_FAILED');
  service.list = () => { throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); };
  const thrown = await rejected(service, 'cron_list', {}, /disk unavailable/);
  assert.equal(thrown.structuredContent.code, 'EIO');
  service.list = () => [{ id: 'task', name: 'task', schedule: {}, action: {} }];
  service.runNow = async () => ({ ok: true });
  const receiptFailure = await rejected(service, 'cron_run', { query: 'task' }, /有效的执行回执/);
  assert.equal(receiptFailure.structuredContent.code, 'INVALID_RUN_RECEIPT');
  assert.equal(receiptFailure.structuredContent.status, 'failed');
  service.runNow = async () => ({ ok: true, status: 'failed', error: 'contradictory receipt' });
  await rejected(service, 'cron_run', { query: 'task' }, /有效的执行回执/);
});

test('cron MCP refuses ambiguous target selection before running or deleting', async () => {
  const { service, calls } = schedulerService();
  await add(service, { name: 'report first' });
  await add(service, { name: 'report second' });
  const result = await rejected(service, 'cron_run', { query: 'report' }, /匹配到多个/);
  assert.equal(result.structuredContent.code, 'AMBIGUOUS_TASK');
  await rejected(service, 'cron_remove', { query: 'missing task' }, /没找到/);
  await add(service, { name: 'report first' });
  const duplicate = await rejected(service, 'cron_remove', { query: 'report first' }, /匹配到多个/);
  assert.equal(duplicate.structuredContent.code, 'AMBIGUOUS_TASK');
  assert.equal(calls.some(([method]) => ['runNow', 'remove'].includes(method)), false);
});

test('registered MCP aliases await receipts and propagate errors with the SDK timeout', async () => {
  const { service } = schedulerService();
  await add(service);
  const server = serverFor(service);
  assert.equal(server.timeout, CRON_MCP_TOOL_TIMEOUT_MS);
  assert.equal(server.timeout, 30000);
  assert.ok(server.tools.length > 8);
  for (const name of ['cron_add', 'cron_update']) {
    const { shape } = server.tools.find((item) => item.name === name);
    assert.ok(shape.command);
    assert.ok(shape.workingDir);
    assert.ok(shape.tz);
  }
  let resolveReceipt;
  service.runNow = () => new Promise((resolve) => { resolveReceipt = resolve; });
  const alias = server.tools.find((item) => item.name === 'cron_run_now');
  const pending = alias.handler({ query: 'daily report' });
  await new Promise((resolve) => setImmediate(resolve));
  resolveReceipt({ ok: false, status: 'already_running', code: 'TASK_RUNNING', runId: 'active-run' });
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'already_running');
  assert.equal(result.structuredContent.runId, 'active-run');
  assert.equal(result.structuredContent.taskId, 'task-1');
});
