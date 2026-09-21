'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCronMcpServer, CRON_MCP_TOOL_TIMEOUT_MS, _execTool } = require('../cron-mcp');

function schedulesFile(t) {
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = fs.mkdtempSync(path.join(tempRoot, 'relay-cron-mcp-test-'));
  const file = path.join(root, 'schedules.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: [], runs: [] }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return file;
}

test('cron MCP persists explicit catchUp=false and scheduled Agent configuration', (t) => {
  const file = schedulesFile(t);
  const text = _execTool(file, 'cron_add', {
    name: 'Agent report',
    prompt: 'write report',
    cron: '0 9 * * *',
    type: 'chat',
    catchUp: false,
    mode: 'agent',
    agentName: 'writer',
  });

  assert.match(text, /已创建/);
  const task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(task.catchUp, false);
  assert.equal(task.action.mode, 'agent');
  assert.equal(task.action.agentName, 'writer');

  const view = JSON.parse(_execTool(file, 'cron_get', { query: 'Agent report' }));
  assert.equal(view.catchUp, false);
  assert.equal(view.mode, 'agent');
  assert.equal(view.agentName, 'writer');
});

test('cron MCP defaults catchUp=true, updates it, and refuses Agent mode without agentName', (t) => {
  const file = schedulesFile(t);
  assert.match(_execTool(file, 'cron_add', {
    name: 'plain report', prompt: 'write', everyMs: 60000,
  }), /已创建/);

  let task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(task.catchUp, true);
  assert.match(_execTool(file, 'cron_update', { query: task.id, catchUp: false }), /已修改/);
  task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(task.catchUp, false);

  const rejected = _execTool(file, 'cron_update', { query: task.id, mode: 'agent' });
  assert.match(rejected, /agentName/);
  task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.notEqual(task.action.mode, 'agent', '失败的修改不应落盘');
});

test('cron MCP rejects schedules that would create enabled but never-running tasks', (t) => {
  const file = schedulesFile(t);
  assert.match(_execTool(file, 'cron_add', {
    name: 'invalid cron', prompt: 'x', cron: '99 9 * * *',
  }), /调度无效/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 0);

  assert.match(_execTool(file, 'cron_add', {
    name: 'valid task', prompt: 'x', everyMs: 60000,
  }), /已创建/);
  const task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.match(_execTool(file, 'cron_update', {
    query: task.id, everyMs: 500,
  }), /调度无效/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].schedule.everyMs, 60000);
});

test('cron MCP creates a real command task with a working directory', (t) => {
  const file = schedulesFile(t);
  assert.match(_execTool(file, 'cron_add', {
    name: 'empty command', everyMs: 60000, type: 'command',
  }), /缺少命令脚本/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 0);

  assert.match(_execTool(file, 'cron_add', {
    name: 'nightly command',
    prompt: 'Write-Output "done"',
    cron: '0 2 * * *',
    type: 'command',
    workingDir: 'C:\\Automation',
  }), /已创建/);

  const task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(task.action.type, 'command');
  assert.equal(task.action.command, 'Write-Output "done"');
  assert.equal(task.action.workingDir, 'C:\\Automation');
  assert.equal(Object.hasOwn(task.action, 'prompt'), false);

  const view = JSON.parse(_execTool(file, 'cron_get', { query: task.id }));
  assert.equal(view.type, 'command');
  assert.equal(view.prompt, 'Write-Output "done"');
  assert.equal(view.command, 'Write-Output "done"');
  assert.equal(view.workingDir, 'C:\\Automation');
});

test('cron MCP infers command when type is omitted and rejects unknown or conflicting types atomically', (t) => {
  const file = schedulesFile(t);
  const initial = fs.readFileSync(file, 'utf8');
  assert.match(_execTool(file, 'cron_add', {
    name: 'unknown type', command: 'Write-Output 0', everyMs: 60000, type: 'shell',
  }), /未知任务类型/);
  assert.equal(fs.readFileSync(file, 'utf8'), initial);

  assert.match(_execTool(file, 'cron_add', {
    name: 'conflicting type', command: 'Write-Output 0', everyMs: 60000, type: ' CHAT ',
  }), /command 字段只能用于/);
  assert.equal(fs.readFileSync(file, 'utf8'), initial);

  assert.match(_execTool(file, 'cron_add', {
    name: 'inferred command', command: 'Write-Output 1', everyMs: 60000,
  }), /已创建/);
  const inferred = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];
  assert.equal(inferred.action.type, 'command');
  assert.equal(inferred.action.command, 'Write-Output 1');
  assert.equal(Object.hasOwn(inferred.action, 'prompt'), false);

  assert.match(_execTool(file, 'cron_add', {
    name: 'normalized command', prompt: 'Write-Output 2', everyMs: 60000, type: ' CoMmAnD ',
  }), /已创建/);
  const normalized = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[1];
  assert.equal(normalized.action.type, 'command');
  assert.equal(normalized.action.command, 'Write-Output 2');
});

test('cron MCP updates command content through prompt or command without changing its type', (t) => {
  const file = schedulesFile(t);
  assert.match(_execTool(file, 'cron_add', {
    name: 'command update', command: 'Write-Output 1', everyMs: 60000, type: 'command',
  }), /已创建/);
  const id = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].id;

  assert.match(_execTool(file, 'cron_update', {
    query: id, prompt: 'Write-Output 2', workingDir: 'D:\\Jobs',
  }), /已修改/);
  let action = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].action;
  assert.equal(action.type, 'command');
  assert.equal(action.command, 'Write-Output 2');
  assert.equal(action.workingDir, 'D:\\Jobs');
  assert.equal(Object.hasOwn(action, 'prompt'), false);

  assert.match(_execTool(file, 'cron_update', {
    query: id, command: 'Write-Output 3', workingDir: '',
  }), /已修改/);
  action = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].action;
  assert.equal(action.type, 'command');
  assert.equal(action.command, 'Write-Output 3');
  assert.equal(action.workingDir, null);
});

test('cron MCP atomically converts legacy chat or image tasks to command', (t) => {
  const file = schedulesFile(t);
  assert.match(_execTool(file, 'cron_add', {
    name: 'legacy chat', prompt: 'Write-Output legacy', everyMs: 60000, type: 'chat', workingDir: 'C:\\Legacy',
  }), /已创建/);
  assert.match(_execTool(file, 'cron_add', {
    name: 'legacy image', prompt: 'old image prompt', everyMs: 60000, type: 'image',
  }), /已创建/);

  assert.match(_execTool(file, 'cron_update', {
    query: 'legacy chat', type: ' COMMAND ',
  }), /已修改/);
  let tasks = JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
  assert.deepEqual(tasks[0].action, {
    type: 'command', command: 'Write-Output legacy', workingDir: 'C:\\Legacy',
  });

  assert.match(_execTool(file, 'cron_update', {
    query: 'legacy image', type: 'command', prompt: 'Write-Output prompt', command: 'Write-Output command',
  }), /已修改/);
  tasks = JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
  assert.deepEqual(tasks[1].action, { type: 'command', command: 'Write-Output command' });
});

test('cron MCP rejects invalid command conversions without partial writes', (t) => {
  const file = schedulesFile(t);
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.tasks.push({
    id: 'empty-chat', name: 'empty legacy chat', enabled: true, catchUp: true,
    schedule: { kind: 'every', everyMs: 60000 },
    action: { type: 'chat', prompt: '' },
  });
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  const beforeMissingContent = fs.readFileSync(file, 'utf8');
  assert.match(_execTool(file, 'cron_update', {
    query: 'empty-chat', name: 'must not persist', type: 'command',
  }), /缺少命令脚本/);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeMissingContent);

  const beforeUnknownType = fs.readFileSync(file, 'utf8');
  assert.match(_execTool(file, 'cron_update', {
    query: 'empty-chat', name: 'must not persist', type: 'shell',
  }), /未知任务类型/);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeUnknownType);

  const beforeImplicitCommand = fs.readFileSync(file, 'utf8');
  assert.match(_execTool(file, 'cron_update', {
    query: 'empty-chat', command: 'Write-Output blocked',
  }), /同时指定 type=command/);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeImplicitCommand);
});

test('cron MCP keeps chat and image prompt updates compatible', (t) => {
  const file = schedulesFile(t);
  assert.match(_execTool(file, 'cron_add', {
    name: 'chat task', prompt: 'old chat', everyMs: 60000, type: 'chat',
  }), /已创建/);
  assert.match(_execTool(file, 'cron_add', {
    name: 'image task', prompt: 'old image', everyMs: 60000, type: 'image',
  }), /已创建/);

  assert.match(_execTool(file, 'cron_update', {
    query: 'chat task', prompt: 'new chat', workingDir: 'C:\\Chat',
  }), /已修改/);
  assert.match(_execTool(file, 'cron_update', {
    query: 'image task', prompt: 'new image',
  }), /已修改/);

  const tasks = JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
  assert.equal(tasks[0].action.type, 'chat');
  assert.equal(tasks[0].action.prompt, 'new chat');
  assert.equal(tasks[0].action.workingDir, 'C:\\Chat');
  assert.equal(tasks[1].action.type, 'image');
  assert.equal(tasks[1].action.prompt, 'new image');

  const beforeRejectedUpdate = fs.readFileSync(file, 'utf8');
  assert.match(_execTool(file, 'cron_update', {
    query: 'image task', command: 'Write-Output "wrong type"',
  }), /只有命令任务/);
  assert.equal(fs.readFileSync(file, 'utf8'), beforeRejectedUpdate, '拒绝的命令字段不应部分改写任务');
});

test('进程内 cron MCP 使用 SDK 服务器级硬超时', () => {
  const schema = () => ({ optional() { return this; }, describe() { return this; } });
  const server = createCronMcpServer({
    createSdkMcpServer: (options) => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    z: { string: schema, number: schema, boolean: schema },
    userDataDir: '',
  });
  assert.equal(server.timeout, CRON_MCP_TOOL_TIMEOUT_MS);
  assert.equal(server.timeout, 30000);
  assert.ok(server.tools.length > 8);
  const add = server.tools.find((item) => item.name === 'cron_add');
  const update = server.tools.find((item) => item.name === 'cron_update');
  assert.ok(add.shape.command);
  assert.ok(add.shape.workingDir);
  assert.ok(update.shape.type);
  assert.ok(update.shape.command);
  assert.ok(update.shape.workingDir);
});
