'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { _execTool: execCronTool } = require('../src/main/scheduling/cron-mcp');

const schedulerModulePath = require.resolve('../src/main/scheduling/scheduler');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadFreshScheduler(spawnStub = null) {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  if (spawnStub) childProcess.spawn = spawnStub;
  delete require.cache[schedulerModulePath];
  try { return require('../src/main/scheduling/scheduler'); }
  finally { childProcess.spawn = originalSpawn; }
}

function createHarness(t, options = {}) {
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const userDataDir = fs.mkdtempSync(path.join(tempRoot, 'relay-scheduler-test-'));
  if (options.seedStore) {
    fs.writeFileSync(path.join(userDataDir, 'schedules.json'), JSON.stringify(options.seedStore, null, 2));
  }
  const scheduler = loadFreshScheduler(options.spawn || null);
  const finished = [];
  const finishedSignal = deferred();
  const runId = options.runId || 'scheduled-run-1';
  const deps = {
    userDataDir,
    agentDir: options.agentDir || path.join(userDataDir, 'agents'),
    runClaudeJob: options.runClaudeJob || (() => { throw new Error('unexpected chat execution'); }),
    resolveChatRoute: options.resolveChatRoute,
    buildMemoryHint: () => '',
    buildSkillCuratorPrompt: () => '',
    generateImage: options.generateImage,
    saveConversation: options.saveConversation || (() => {}),
    loadConversation: options.loadConversation || (() => null),
    readAppSettings: options.readAppSettings || (() => ({ allowCommandTasks: true })),
    webhookRequestOptions: options.webhookRequestOptions,
    webhookAudit: options.webhookAudit,
    getMainWindow: () => null,
    refreshTray: () => {},
    notify: () => {},
    taskRunStart: () => runId,
    taskRunFinish: (id, result) => {
      finished.push({ id, result });
      finishedSignal.resolve(result);
      if (options.finishThrows) throw new Error('finish failed');
    },
    onSkillCuratorStart: options.onSkillCuratorStart,
    onSkillCuratorDone: options.onSkillCuratorDone,
  };
  scheduler.init(deps);
  t.after(() => {
    scheduler.shutdown();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    delete require.cache[schedulerModulePath];
  });
  return { scheduler, runId, finished, finishedSignal, userDataDir, deps };
}

function createDisabledTask(scheduler, action, extra = {}) {
  return scheduler.create({
    name: 'cancel test',
    enabled: false,
    builtin: extra.builtin || null,
    schedule: { kind: 'every', everyMs: 60000 },
    action,
    delivery: { notify: false, saveToHistory: false },
  }).task;
}

function makeRequestStub(specs, calls = []) {
  let index = 0;
  return {
    calls,
    request(options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = (error) => {
        if (error) queueMicrotask(() => request.emit('error', error));
      };
      request.end = (body) => {
        calls.push({ options, body: String(body) });
        const spec = specs[Math.min(index++, specs.length - 1)] || { statusCode: 200 };
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = spec.statusCode || 0;
          response.headers = spec.headers || {};
          response.destroy = (error) => {
            if (error) queueMicrotask(() => response.emit('error', error));
          };
          callback(response);
          if (spec.error) {
            const error = new Error(spec.error.message || 'response reset');
            error.code = spec.error.code || 'ECONNRESET';
            response.emit('error', error);
            return;
          }
          if (spec.body) response.emit('data', Buffer.from(spec.body));
          response.emit('end');
        });
      };
      return request;
    },
  };
}

test('tray hint is quiet before initialization and follows the scheduler lifecycle', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const fresh = loadFreshScheduler();
  assert.equal(fresh.nextTaskHint(), null);
  assert.equal(warnings.length, 0);

  const { scheduler } = createHarness(t);
  const at = new Date(Date.now() + 3600000).toISOString();
  const result = scheduler.create({
    name: 'future tray task', enabled: true,
    schedule: { kind: 'at', at },
    action: { type: 'chat', prompt: 'must not run during this test' },
  });
  assert.equal(result.ok, true);
  assert.equal(scheduler.nextTaskHint().at, Date.parse(at));
  assert.match(scheduler.nextTaskHint().label, /future tray task/);
  scheduler.shutdown();
  assert.equal(scheduler.nextTaskHint(), null);
  assert.equal(warnings.length, 0);
});

test('strict schedule store validation refuses malformed structure without overwriting it', (t) => {
  const harness = createHarness(t);
  const file = path.join(harness.userDataDir, 'schedules.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: {}, runs: [] }));

  const result = harness.scheduler.create({
    name: 'must fail', enabled: false,
    schedule: { kind: 'every', everyMs: 60000 },
    action: { type: 'chat', prompt: 'x' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'STORE_READ_FAILED');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks, {});
});

test('catchUp defaults to true and catchUp=false records a missed run as skipped', (t) => {
  const past = new Date(Date.now() - 60000).toISOString();
  const taskId = 'skip-missed-task';
  const harness = createHarness(t, {
    seedStore: {
      version: 1,
      tasks: [{
        id: taskId,
        name: 'skip missed',
        enabled: true,
        catchUp: false,
        schedule: { kind: 'every', everyMs: 60000 },
        action: { type: 'chat', prompt: 'must not execute' },
        delivery: { notify: false, saveToHistory: false },
        nextRunAt: past,
        lastRunAt: null,
        runCount: 0,
      }],
      runs: [],
    },
  });

  const skipped = harness.scheduler.get(taskId);
  assert.equal(skipped.catchUp, false);
  assert.equal(skipped.lastStatus, 'skipped');
  assert.equal(skipped.runCount, 0);
  assert.ok(Date.parse(skipped.nextRunAt) > Date.now());
  const history = harness.scheduler.runs(taskId);
  assert.equal(history[0].status, 'skipped');
  assert.equal(history[0].trigger, 'catchup');
  assert.equal(history[0].scheduledFor, past);

  const created = createDisabledTask(harness.scheduler, { type: 'chat', prompt: 'default' });
  assert.equal(created.catchUp, true);
});

test('startup closes stale webhook pending states instead of leaving delivery spinning forever', (t) => {
  const eventId = 'delivery-stale-1';
  const harness = createHarness(t, {
    seedStore: {
      version: 1,
      tasks: [{
        id: 'pending-task', name: 'pending', enabled: false,
        schedule: { kind: 'every', everyMs: 60000 },
        action: { type: 'chat', prompt: 'x' },
        delivery: { notify: false, saveToHistory: false },
        lastDelivery: { webhook: { status: 'pending', eventId, destinationHash: 'abc' } },
      }],
      runs: [{
        taskId: 'pending-task', runId: 'old-run', at: new Date().toISOString(), status: 'ok',
        delivery: { webhook: { status: 'pending', eventId, destinationHash: 'abc' } },
      }],
    },
    webhookAudit: () => {},
  });

  assert.equal(harness.scheduler.get('pending-task').lastDelivery.webhook.status, 'failed');
  assert.equal(harness.scheduler.get('pending-task').lastDelivery.webhook.code, 'WEBHOOK_INTERRUPTED');
  assert.equal(harness.scheduler.runs('pending-task')[0].delivery.webhook.status, 'failed');
});

test('普通定时对话默认使用主目录，有效的显式目录原样传入执行器', async (t) => {
  const cases = [
    {
      name: 'default-home',
      prepare() {
        return { workingDir: null, expectedCwd: os.homedir(), expectedValid: null };
      },
    },
    {
      name: 'valid-explicit-directory',
      prepare(harness) {
        const dir = path.join(harness.userDataDir, 'chat-workspace');
        fs.mkdirSync(dir);
        return { workingDir: dir, expectedCwd: dir, expectedValid: dir };
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      let launched = null;
      const harness = createHarness(st, {
        runId: `scheduled-chat-working-dir-${item.name}`,
        runClaudeJob(args) {
          launched = args;
          queueMicrotask(() => args.onEvent({ type: 'job-done', exitCode: 0 }));
          return { child: { kill: () => true } };
        },
      });
      const prepared = item.prepare(harness);
      const action = { type: 'chat', prompt: 'working directory check', memory: 'off' };
      if (prepared.workingDir) action.workingDir = prepared.workingDir;
      const task = createDisabledTask(harness.scheduler, action);

      await harness.scheduler.runNow(task.id);
      const result = await harness.finishedSignal.promise;

      assert.equal(result.ok, true);
      assert.equal(launched.cwd, prepared.expectedCwd);
      assert.equal(launched.validWorkingDir, prepared.expectedValid);
      assert.equal(harness.scheduler.get(task.id).lastStatus, 'ok');
    });
  }
});

test('普通定时对话的显式工作目录无效时失败且不启动执行器', async (t) => {
  const cases = [
    {
      name: 'relative-path',
      prepare() {
        return { workingDir: 'relative-chat-dir', expected: /必须是绝对路径/, restore: () => {} };
      },
    },
    {
      name: 'missing-directory',
      prepare(harness) {
        return {
          workingDir: path.join(harness.userDataDir, 'missing-chat-dir'),
          expected: /路径不存在/,
          restore: () => {},
        };
      },
    },
    {
      name: 'not-a-directory',
      prepare(harness) {
        const file = path.join(harness.userDataDir, 'chat-file.txt');
        fs.writeFileSync(file, 'not a directory');
        return { workingDir: file, expected: /不是目录/, restore: () => {} };
      },
    },
    {
      name: 'inaccessible',
      prepare(harness) {
        const dir = path.join(harness.userDataDir, 'inaccessible-chat-dir');
        fs.mkdirSync(dir);
        const originalAccessSync = fs.accessSync;
        fs.accessSync = (candidate, mode) => {
          if (candidate === dir) {
            const error = new Error('access denied');
            error.code = 'EACCES';
            throw error;
          }
          return originalAccessSync(candidate, mode);
        };
        return { workingDir: dir, expected: /无法访问/, restore: () => { fs.accessSync = originalAccessSync; } };
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      let launches = 0;
      const harness = createHarness(st, {
        runId: `scheduled-chat-invalid-working-dir-${item.name}`,
        runClaudeJob() {
          launches += 1;
          throw new Error('must not launch');
        },
      });
      const prepared = item.prepare(harness);
      try {
        const task = createDisabledTask(harness.scheduler, {
          type: 'chat', prompt: 'must not run', memory: 'off', workingDir: prepared.workingDir,
        });
        await harness.scheduler.runNow(task.id);
        const result = await harness.finishedSignal.promise;

        assert.equal(result.ok, false);
        assert.match(result.error, /定时对话工作目录不可用/);
        assert.match(result.error, prepared.expected);
        assert.equal(launches, 0);
        assert.equal(harness.scheduler.get(task.id).lastStatus, 'error');
      } finally {
        prepared.restore();
      }
    });
  }
});

test('scheduled Agent mode validates and launches the configured subagent instead of falling back to plain', async (t) => {
  let launched = null;
  let projectRoot = null;
  const harness = createHarness(t, {
    runId: 'scheduled-agent-run',
    readAppSettings: () => ({ allowCommandTasks: true, agentProjects: { writer: projectRoot } }),
    runClaudeJob(args) {
      launched = args;
      queueMicrotask(() => args.onEvent({ type: 'job-done', exitCode: 0 }));
      return { child: { kill: () => true } };
    },
  });
  fs.mkdirSync(harness.deps.agentDir, { recursive: true });
  fs.writeFileSync(path.join(harness.deps.agentDir, 'writer-package.md'), '---\nname: writer\ndescription: test\n---\n');
  projectRoot = path.join(harness.userDataDir, 'writer-project');
  fs.mkdirSync(projectRoot);
  const task = createDisabledTask(harness.scheduler, {
    type: 'chat', prompt: 'draft report', mode: 'agent', agentName: 'writer', memory: 'off',
  });

  await harness.scheduler.runNow(task.id);
  const result = await harness.finishedSignal.promise;

  assert.equal(result.ok, true);
  assert.match(launched.prompt, /^请使用「writer」子智能体\(subagent\)/);
  assert.equal(launched.cwd, projectRoot);
  assert.equal(launched.validWorkingDir, projectRoot);
  assert.equal(launched.agentProjectRoot, projectRoot);
  assert.equal(launched.background, true);
  assert.equal(launched.permissionMode, 'bypassPermissions', '普通定时对话应显式采用无人值守自动放行策略');
  assert.equal(launched.canUseTool, null, '无人值守任务不应创建永远无人响应的审批回调');
  assert.equal(harness.scheduler.get(task.id).lastStatus, 'ok');
});

test('cron MCP 创建的命令任务可由 scheduler 直接执行', async (t) => {
  let spawned = null;
  function spawnStub(command, args, options) {
    spawned = { command, args, options };
    const child = new EventEmitter();
    child.pid = 2048;
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end('relay-command-smoke\n');
      child.exitCode = 0;
      child.emit('close', 0);
    });
    return child;
  }

  const harness = createHarness(t, { runId: 'cron-command-run', spawn: spawnStub });
  const file = path.join(harness.userDataDir, 'schedules.json');
  assert.match(execCronTool(file, 'cron_add', {
    name: 'cron command smoke',
    type: 'command',
    command: 'Write-Output "relay-command-smoke"',
    everyMs: 60 * 60 * 1000,
  }), /已创建/);
  const task = JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0];

  await harness.scheduler.runNow(task.id);
  const result = await harness.finishedSignal.promise;

  assert.equal(result.ok, true);
  assert.equal(result.summary, 'relay-command-smoke');
  assert.equal(spawned.command, 'powershell.exe');
  assert.deepEqual(spawned.args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.equal(spawned.args.at(-1), 'Write-Output "relay-command-smoke"');
  assert.equal(spawned.options.cwd, os.homedir(), '未设置工作目录时应使用用户主目录');
  assert.equal(harness.scheduler.runs(task.id)[0].status, 'ok');
});

test('命令任务的显式工作目录不存在时失败且不启动 PowerShell', async (t) => {
  let spawnCalls = 0;
  const harness = createHarness(t, {
    runId: 'command-missing-working-dir-run',
    spawn() {
      spawnCalls += 1;
      throw new Error('must not spawn');
    },
  });
  const missingDir = path.join(harness.userDataDir, 'does-not-exist');
  const task = createDisabledTask(harness.scheduler, {
    type: 'command', command: 'Write-Output "must-not-run"', workingDir: missingDir,
  });

  await harness.scheduler.runNow(task.id);
  const result = await harness.finishedSignal.promise;

  assert.equal(result.ok, false);
  assert.match(result.error, /命令工作目录不可用/);
  assert.match(result.error, /路径不存在/);
  assert.equal(spawnCalls, 0);
  assert.equal(harness.scheduler.get(task.id).lastStatus, 'error');
});

test('命令任务拒绝把文件或不可访问路径当作工作目录', async (t) => {
  const cases = [
    {
      name: 'relative-path',
      prepare() {
        return { workingDir: 'relative-command-dir', expected: /必须是绝对路径/, restore: () => {} };
      },
    },
    {
      name: 'not-a-directory',
      prepare(harness) {
        const file = path.join(harness.userDataDir, 'plain-file.txt');
        fs.writeFileSync(file, 'not a directory');
        return { workingDir: file, expected: /不是目录/, restore: () => {} };
      },
    },
    {
      name: 'inaccessible',
      prepare(harness) {
        const dir = path.join(harness.userDataDir, 'inaccessible-directory');
        fs.mkdirSync(dir);
        const originalAccessSync = fs.accessSync;
        fs.accessSync = (candidate, mode) => {
          if (candidate === dir) {
            const error = new Error('access denied');
            error.code = 'EACCES';
            throw error;
          }
          return originalAccessSync(candidate, mode);
        };
        return { workingDir: dir, expected: /无法访问/, restore: () => { fs.accessSync = originalAccessSync; } };
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (st) => {
      let spawnCalls = 0;
      const harness = createHarness(st, {
        runId: `command-invalid-working-dir-${item.name}`,
        spawn() {
          spawnCalls += 1;
          throw new Error('must not spawn');
        },
      });
      const prepared = item.prepare(harness);
      try {
        const task = createDisabledTask(harness.scheduler, {
          type: 'command', command: 'Write-Output "must-not-run"', workingDir: prepared.workingDir,
        });
        await harness.scheduler.runNow(task.id);
        const result = await harness.finishedSignal.promise;

        assert.equal(result.ok, false);
        assert.match(result.error, prepared.expected);
        assert.equal(spawnCalls, 0);
        assert.equal(harness.scheduler.get(task.id).lastStatus, 'error');
      } finally {
        prepared.restore();
      }
    });
  }
});

test('命令任务仅在显式工作目录有效时将其传给 PowerShell', async (t) => {
  let spawned = null;
  function spawnStub(command, args, options) {
    spawned = { command, args, options };
    const child = new EventEmitter();
    child.pid = 2050;
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('close', 0);
    });
    return child;
  }

  const harness = createHarness(t, { runId: 'command-valid-working-dir-run', spawn: spawnStub });
  const workingDir = path.join(harness.userDataDir, 'command-workspace');
  fs.mkdirSync(workingDir);
  const task = createDisabledTask(harness.scheduler, {
    type: 'command', command: 'Write-Output "ok"', workingDir,
  });

  await harness.scheduler.runNow(task.id);
  const result = await harness.finishedSignal.promise;

  assert.equal(result.ok, true);
  assert.equal(spawned.command, 'powershell.exe');
  assert.equal(spawned.options.cwd, workingDir);
  assert.equal(harness.scheduler.get(task.id).lastStatus, 'ok');
});

test('scheduled Agent mode fails visibly when the Agent is missing', async (t) => {
  let launches = 0;
  const harness = createHarness(t, {
    runId: 'scheduled-agent-missing-run',
    runClaudeJob() { launches += 1; throw new Error('must not launch plain'); },
  });
  fs.mkdirSync(harness.deps.agentDir, { recursive: true });
  const task = createDisabledTask(harness.scheduler, {
    type: 'chat', prompt: 'draft report', mode: 'agent', agentName: 'missing', memory: 'off',
  });

  await harness.scheduler.runNow(task.id);
  const result = await harness.finishedSignal.promise;

  assert.equal(result.ok, false);
  assert.match(result.error, /Agent 配置错误/);
  assert.equal(launches, 0);
  assert.equal(harness.scheduler.get(task.id).lastStatus, 'error');
});

test('webhook address policy blocks private, metadata and special-purpose IP ranges', () => {
  const scheduler = loadFreshScheduler();
  for (const address of [
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.168.1.1',
    '::1', 'fc00::1', 'fe80::1', '2001::1', '2001:1::1', '2001:2::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1',
  ]) assert.equal(scheduler._isPublicNetworkAddress(address), false, address);
  assert.equal(scheduler._isPublicNetworkAddress('93.184.216.34'), true);
  assert.equal(scheduler._isPublicNetworkAddress('2606:2800:220:1:248:1893:25c8:1946'), true);
  delete require.cache[schedulerModulePath];
});

test('webhook revalidates redirects and blocks a public-to-private redirect before connecting', async () => {
  const scheduler = loadFreshScheduler();
  const transport = makeRequestStub([{ statusCode: 302, headers: { location: 'https://private.example/hook' } }]);
  const outcome = await scheduler._deliverWebhook(
    { url: 'https://public.example/hook', secret: '0123456789abcdef', maxRetries: 0 },
    { event: 'test' },
    { taskId: 't', runId: 'r', eventId: 'e', destinationHash: 'h' },
    {
      lookup: async (host) => [{ address: host === 'private.example' ? '127.0.0.1' : '93.184.216.34', family: 4 }],
      request: transport.request,
      sleep: async () => {},
    },
  );

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.code, 'WEBHOOK_BLOCKED_ADDRESS');
  assert.equal(transport.calls.length, 1);
  delete require.cache[schedulerModulePath];
});

test('webhook signs the exact body and retries bounded transient HTTP failures', async () => {
  const scheduler = loadFreshScheduler();
  const secret = '0123456789abcdef';
  const transport = makeRequestStub([{ statusCode: 500 }, { statusCode: 204 }]);
  const outcome = await scheduler._deliverWebhook(
    { url: 'https://public.example/hook', secret, maxRetries: 2 },
    { event: 'test', value: 1 },
    { taskId: 't', runId: 'r', eventId: 'event-1', destinationHash: 'h' },
    {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: transport.request,
      sleep: async () => {},
      now: () => 123456789,
    },
  );

  assert.equal(outcome.status, 'delivered');
  assert.equal(outcome.attempts, 2);
  assert.equal(transport.calls.length, 2);
  const first = transport.calls[0];
  const expected = require('node:crypto').createHmac('sha256', secret)
    .update(`123456789.${first.body}`).digest('hex');
  assert.equal(first.options.headers['x-relay-signature'], `sha256=${expected}`);
  assert.equal(first.options.headers['x-relay-delivery-id'], 'event-1');
  delete require.cache[schedulerModulePath];
});

test('webhook retries a transient response-stream error and enforces response/request bounds', async () => {
  const scheduler = loadFreshScheduler();
  const transport = makeRequestStub([{ statusCode: 200, error: { code: 'ECONNRESET' } }, { statusCode: 200 }]);
  const common = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: transport.request,
    sleep: async () => {},
  };
  const config = { url: 'https://public.example/hook', secret: '0123456789abcdef', maxRetries: 1 };
  const context = { taskId: 't', runId: 'r', eventId: 'event-2', destinationHash: 'h' };
  const recovered = await scheduler._deliverWebhook(config, { event: 'test' }, context, common);
  assert.equal(recovered.status, 'delivered');
  assert.equal(recovered.attempts, 2);

  const tooLarge = await scheduler._deliverWebhook(config, { value: 'x'.repeat(70 * 1024) }, context, common);
  assert.equal(tooLarge.status, 'failed');
  assert.equal(tooLarge.attempts, 0);
  assert.match(tooLarge.error, /64 KiB/);

  const oversizedResponse = makeRequestStub([{ statusCode: 200, body: 'x'.repeat(70 * 1024) }]);
  const responseOutcome = await scheduler._deliverWebhook(
    { ...config, maxRetries: 0 }, { event: 'test' }, context,
    { ...common, request: oversizedResponse.request },
  );
  assert.equal(responseOutcome.status, 'failed');
  assert.equal(responseOutcome.code, 'WEBHOOK_RESPONSE_TOO_LARGE');
  assert.equal(oversizedResponse.calls.length, 1);
  delete require.cache[schedulerModulePath];
});

test('webhook delivery failure remains separate from a successful scheduled task result', async (t) => {
  const transport = makeRequestStub([{ statusCode: 400 }]);
  const harness = createHarness(t, {
    runId: 'scheduled-webhook-run',
    webhookAudit: () => {},
    webhookRequestOptions: {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: transport.request,
      sleep: async () => {},
    },
    runClaudeJob(args) {
      queueMicrotask(() => args.onEvent({ type: 'result', result: 'done' }));
      queueMicrotask(() => args.onEvent({ type: 'job-done', exitCode: 0 }));
      return { child: { kill: () => true } };
    },
  });
  const task = harness.scheduler.create({
    name: 'webhook result separation', enabled: false,
    schedule: { kind: 'every', everyMs: 60000 },
    action: { type: 'chat', prompt: 'done', memory: 'off' },
    delivery: {
      notify: false, saveToHistory: false,
      webhook: { url: 'https://public.example/hook', secret: '0123456789abcdef', maxRetries: 0 },
    },
  }).task;

  await harness.scheduler.runNow(task.id);
  assert.equal((await harness.finishedSignal.promise).ok, true);
  let stored = null;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    stored = harness.scheduler.get(task.id);
    if (stored.lastDelivery && stored.lastDelivery.webhook.status !== 'pending') break;
  }
  const history = harness.scheduler.runs(task.id)[0];
  assert.equal(stored.lastStatus, 'ok');
  assert.equal(stored.lastError, null);
  assert.equal(stored.lastDelivery.webhook.status, 'failed');
  assert.equal(history.status, 'ok');
  assert.equal(history.delivery.webhook.status, 'failed');
});

test('Windows command cancellation uses taskkill /T /F for the entire process tree', () => {
  const scheduler = loadFreshScheduler();
  const child = { pid: 4242, exitCode: null, killCalls: 0, kill() { this.killCalls += 1; } };
  const killer = new EventEmitter();
  killer.unref = () => {};
  const calls = [];

  const requested = scheduler._terminateCommandTree(child, {
    platform: 'win32',
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return killer;
    },
  });

  assert.equal(requested, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'taskkill.exe');
  assert.deepEqual(calls[0].args, ['/PID', '4242', '/T', '/F']);
  assert.equal(calls[0].options.shell, false);
  killer.emit('close', 0);
  assert.equal(child.killCalls, 0);
  delete require.cache[schedulerModulePath];
});

test('cancelRun terminates a running chat child and finishes exactly once as canceled', async (t) => {
  let eventSink = null;
  let killCalls = 0;
  const harness = createHarness(t, {
    runId: 'scheduled-chat-run',
    runClaudeJob(args) {
      eventSink = args.onEvent;
      return {
        child: {
          pid: 1001,
          kill() {
            killCalls += 1;
            queueMicrotask(() => {
              eventSink({ type: 'job-done', exitCode: null, error: 'aborted' });
              eventSink({ type: 'job-done', exitCode: 0 });
            });
            return true;
          },
        },
      };
    },
  });
  const task = createDisabledTask(harness.scheduler, { type: 'chat', prompt: 'wait' });

  assert.deepEqual(await harness.scheduler.runNow(task.id), { ok: true, code: 'TASK_STARTED' });
  assert.equal(harness.scheduler.cancelRun(harness.runId), true);
  assert.equal(harness.scheduler.cancelRun(harness.runId), true, 'repeated request remains idempotently accepted while stopping');
  const result = await harness.finishedSignal.promise;

  assert.equal(killCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  assert.equal(result.error, '任务已取消');
  assert.equal(harness.finished.length, 1);
  assert.equal(harness.scheduler.cancelRun(harness.runId), false, 'finished run is no longer cancelable');
  const history = harness.scheduler.runs(task.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'canceled');
});

test('cancelRun terminates a running command and records canceled instead of its exit code', async (t) => {
  let commandChild = null;
  const spawnCalls = [];
  function spawnStub(command, args) {
    spawnCalls.push({ command, args });
    if (command === 'taskkill.exe') {
      const killer = new EventEmitter();
      killer.unref = () => {};
      queueMicrotask(() => {
        killer.emit('close', 0);
        if (commandChild && commandChild.exitCode === null) {
          commandChild.exitCode = 1;
          commandChild.emit('close', 1);
        }
      });
      return killer;
    }
    commandChild = new EventEmitter();
    commandChild.pid = 2002;
    commandChild.exitCode = null;
    commandChild.stdout = new PassThrough();
    commandChild.stderr = new PassThrough();
    commandChild.killCalls = 0;
    commandChild.kill = () => {
      commandChild.killCalls += 1;
      queueMicrotask(() => {
        if (commandChild.exitCode !== null) return;
        commandChild.exitCode = 1;
        commandChild.emit('close', 1);
      });
      return true;
    };
    return commandChild;
  }
  const harness = createHarness(t, { runId: 'scheduled-command-run', spawn: spawnStub });
  const task = createDisabledTask(harness.scheduler, { type: 'command', command: 'Start-Sleep 30' });

  await harness.scheduler.runNow(task.id);
  assert.equal(harness.scheduler.cancelRun(harness.runId), true);
  const result = await harness.finishedSignal.promise;

  assert.equal(result.canceled, true);
  assert.equal(harness.finished.length, 1);
  assert.equal(spawnCalls[0].command, 'powershell.exe');
  if (process.platform === 'win32') {
    assert.equal(spawnCalls[1].command, 'taskkill.exe');
    assert.ok(spawnCalls[1].args.includes('/T'));
  } else {
    assert.equal(commandChild.killCalls, 1);
  }
  assert.equal(harness.scheduler.runs(task.id)[0].status, 'canceled');
});

test('cancelRun cancels preparation before chat spawn and unknown/finished ids return false', async (t) => {
  let chatStarts = 0;
  const preparation = deferred();
  const harness = createHarness(t, {
    runId: 'scheduled-preparing-run',
    onSkillCuratorStart: () => preparation.promise,
    runClaudeJob() { chatStarts += 1; throw new Error('must not spawn'); },
  });
  const task = createDisabledTask(
    harness.scheduler,
    { type: 'chat', prompt: 'curate' },
    { builtin: 'skill-curator' },
  );

  await harness.scheduler.runNow(task.id);
  assert.equal(harness.scheduler.cancelRun('missing-run'), false);
  assert.equal(harness.scheduler.cancelRun(harness.runId), true);
  const result = await harness.finishedSignal.promise;

  assert.equal(result.canceled, true);
  assert.equal(chatStarts, 0);
  assert.equal(harness.finished.length, 1);
  assert.equal(harness.scheduler.cancelRun(harness.runId), false);
  preparation.resolve();
});

test('a failing taskRunFinish callback is not invoked twice', async (t) => {
  let eventSink;
  const harness = createHarness(t, {
    runId: 'scheduled-finish-once-run',
    finishThrows: true,
    runClaudeJob(args) {
      eventSink = args.onEvent;
      queueMicrotask(() => eventSink({ type: 'job-done', exitCode: 0 }));
      return { child: { kill: () => true } };
    },
  });
  const task = createDisabledTask(harness.scheduler, { type: 'chat', prompt: 'done' });

  await harness.scheduler.runNow(task.id);
  await harness.finishedSignal.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.finished.length, 1);
});

test('skill curator runs only inside its prepared staging workspace and finalizes the context', async (t) => {
  let launched = null;
  let finalized = null;
  const context = {
    id: 'curator-review-1',
    stagingRoot: os.tmpdir(),
    prompt: 'isolated curator prompt',
    canUseTool: async () => ({ behavior: 'allow' }),
  };
  const harness = createHarness(t, {
    runId: 'scheduled-curator-run',
    onSkillCuratorStart: () => context,
    onSkillCuratorDone: async (result, received) => { finalized = { result, received }; },
    runClaudeJob(args) {
      launched = args;
      queueMicrotask(() => args.onEvent({ type: 'job-done', exitCode: 0 }));
      return { child: { kill: () => true } };
    },
  });
  const task = createDisabledTask(
    harness.scheduler,
    { type: 'chat', prompt: 'must not use live prompt', workingDir: '/formal/skills' },
    { builtin: 'skill-curator' },
  );

  await harness.scheduler.runNow(task.id);
  await harness.finishedSignal.promise;

  assert.equal(launched.prompt, context.prompt);
  assert.equal(launched.cwd, context.stagingRoot);
  assert.deepEqual(launched.tools, ['Read', 'Write', 'Edit', 'Glob', 'Grep']);
  assert.equal(launched.includeMemoryDirectory, false);
  assert.equal(launched.permissionMode, 'default');
  assert.strictEqual(launched.canUseTool, context.canUseTool);
  assert.strictEqual(finalized.received, context);
  assert.equal(finalized.result.ok, true);
});

test('sparse cron lookup jumps across years without losing leap-day schedules', () => {
  const scheduler = loadFreshScheduler();
  const start = new Date(2025, 2, 1, 0, 0, 0, 0);
  const before = Date.now();
  const next = scheduler._computeNextRun({
    schedule: { kind: 'cron', cron: '17 4 29 2 *', exact: true },
  }, start.getTime());

  const date = new Date(next);
  assert.equal(date.getFullYear(), 2028);
  assert.equal(date.getMonth(), 1);
  assert.equal(date.getDate(), 29);
  assert.equal(date.getHours(), 4);
  assert.equal(date.getMinutes(), 17);
  assert.ok(Date.now() - before < 1000, 'sparse cron lookup must not scan minute-by-minute');
  delete require.cache[schedulerModulePath];
});

test('manual runs and non-schedule edits preserve an every task planned trigger', async (t) => {
  const harness = createHarness(t, {
    runId: 'manual-grid-run',
    runClaudeJob(args) {
      queueMicrotask(() => args.onEvent({ type: 'job-done', exitCode: 0 }));
      return { child: { kill: () => true } };
    },
  });
  const created = harness.scheduler.create({
    name: 'stable grid', enabled: true,
    schedule: { kind: 'every', everyMs: 60000 },
    action: { type: 'chat', prompt: 'done', memory: 'off' },
    delivery: { notify: false, saveToHistory: false },
  }).task;
  const planned = created.nextRunAt;

  const edited = harness.scheduler.update(created.id, { name: 'renamed only' });
  assert.equal(edited.task.nextRunAt, planned);
  await harness.scheduler.runNow(created.id);
  await harness.finishedSignal.promise;
  assert.equal(harness.scheduler.get(created.id).nextRunAt, planned);
});

test('persistent scheduled sessions never resume across providers and carry Relay history forward', async (t) => {
  const oldRoute = { providerId: 'provider-old', providerRevision: 2, routeTier: 'haiku' };
  const newRoute = { providerId: 'provider-new', providerRevision: 5, routeTier: 'haiku' };
  const history = {
    id: 'scheduled-history-1',
    title: 'provider migration',
    sessionId: 'old-session-id',
    sessionProviderId: oldRoute.providerId,
    sessionProviderRevision: oldRoute.providerRevision,
    sessionRouteTier: oldRoute.routeTier,
    turns: [{ user: '上一轮问题', assistant: '上一轮结论', ts: new Date().toISOString() }],
  };
  let launched = null;
  let savedConversation = null;
  const harness = createHarness(t, {
    runId: 'scheduled-provider-migration-run',
    resolveChatRoute: () => newRoute,
    loadConversation: (id) => id === history.id ? history : null,
    saveConversation: (conv) => { savedConversation = JSON.parse(JSON.stringify(conv)); },
    runClaudeJob(args) {
      launched = args;
      queueMicrotask(() => {
        args.onEvent({ type: 'system', session_id: 'new-session-id' });
        args.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '新服务商结果' }] } });
        args.onEvent({ type: 'job-done', exitCode: 0 });
      });
      return {
        child: { kill: () => true },
        sessionRoute: newRoute,
        resumeAccepted: false,
      };
    },
  });
  const created = harness.scheduler.create({
    name: 'provider migration',
    enabled: false,
    schedule: { kind: 'every', everyMs: 60000 },
    action: {
      type: 'chat', prompt: '执行本轮任务', memory: 'off', model: 'haiku',
      sessionMode: 'session', sessionRef: 'old-session-id', sessionRoute: oldRoute,
    },
    delivery: { notify: false, saveToHistory: true },
  }).task;
  const storeFile = path.join(harness.userDataDir, 'schedules.json');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.tasks.find((item) => item.id === created.id).lastConvId = history.id;
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));

  await harness.scheduler.runNow(created.id);
  const result = await harness.finishedSignal.promise;

  assert.equal(result.ok, true);
  assert.equal(launched.sessionId, null);
  assert.deepEqual(launched.sessionRoute, oldRoute);
  assert.match(launched.prompt, /\[Relay 会话迁移\]/);
  assert.match(launched.prompt, /上一轮问题/);
  assert.match(launched.prompt, /执行本轮任务/);
  const persisted = harness.scheduler.get(created.id);
  assert.equal(persisted.action.sessionRef, 'new-session-id');
  assert.deepEqual(persisted.action.sessionRoute, newRoute);
  assert.equal(savedConversation.sessionId, 'new-session-id');
  assert.equal(savedConversation.sessionProviderId, newRoute.providerId);
  assert.equal(savedConversation.sessionProviderRevision, newRoute.providerRevision);
  assert.equal(savedConversation.sessionRouteTier, newRoute.routeTier);
});

test('power resume records skipped tasks and catch-up tasks are launched only once', async (t) => {
  let launches = 0;
  const harness = createHarness(t, {
    runId: 'resume-catchup-run',
    runClaudeJob(args) {
      launches += 1;
      queueMicrotask(() => args.onEvent({ type: 'job-done', exitCode: 0 }));
      return { child: { kill: () => true } };
    },
  });
  const skipped = harness.scheduler.create({
    name: 'resume skip', enabled: true, catchUp: false,
    schedule: { kind: 'every', everyMs: 60000 },
    action: { type: 'chat', prompt: 'skip', memory: 'off' },
    delivery: { notify: false, saveToHistory: false },
  }).task;
  const caught = harness.scheduler.create({
    name: 'resume catch', enabled: true, catchUp: true,
    schedule: { kind: 'every', everyMs: 60000 },
    action: { type: 'chat', prompt: 'catch', memory: 'off' },
    delivery: { notify: false, saveToHistory: false },
  }).task;
  const file = path.join(harness.userDataDir, 'schedules.json');
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const past = new Date(Date.now() - 120000).toISOString();
  for (const task of store.tasks) task.nextRunAt = past;
  fs.writeFileSync(file, JSON.stringify(store, null, 2));

  harness.scheduler.onResume();
  harness.scheduler.onResume();
  const result = await Promise.race([
    harness.finishedSignal.promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('resume catch-up timed out')), 1000)),
  ]);

  assert.equal(result.ok, true);
  assert.equal(launches, 1);
  assert.equal(harness.scheduler.get(skipped.id).lastStatus, 'skipped');
  assert.equal(harness.scheduler.runs(skipped.id)[0].status, 'skipped');
  assert.equal(harness.scheduler.runs(caught.id)[0].trigger, 'catchup');
});

test('pinned webhook lookup honors Node all=true callback shape', async () => {
  const scheduler = loadFreshScheduler();
  let pinnedRecords = null;
  const request = (options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = () => {
      options.lookup('public.example', { all: true }, (error, records) => {
        assert.ifError(error);
        pinnedRecords = records;
        const response = new EventEmitter();
        response.statusCode = 204;
        response.headers = {};
        response.destroy = () => {};
        callback(response);
        response.emit('end');
      });
    };
    return req;
  };

  const response = await scheduler._requestWebhookOnce(
    new URL('https://public.example/hook'),
    { address: '93.184.216.34', family: 4 },
    '{}', '0123456789abcdef', { eventId: 'lookup-all' }, { request },
  );
  assert.deepEqual(pinnedRecords, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(response.statusCode, 204);
  delete require.cache[schedulerModulePath];
});

test('sessionRef persistence failure cannot leave a scheduled chat running forever', async (t) => {
  let schedulesFilePath = null;
  const harness = createHarness(t, {
    runId: 'session-persist-failure-run',
    runClaudeJob(args) {
      queueMicrotask(() => {
        args.onEvent({ type: 'system', session_id: 'new-session-id' });
        fs.writeFileSync(schedulesFilePath, '{ broken json');
        args.onEvent({ type: 'job-done', exitCode: 0 });
      });
      return { child: { kill: () => true } };
    },
  });
  schedulesFilePath = path.join(harness.userDataDir, 'schedules.json');
  const task = createDisabledTask(harness.scheduler, {
    type: 'chat', prompt: 'done', memory: 'off', sessionMode: 'session', sessionRef: 'old-session-id',
  });

  await harness.scheduler.runNow(task.id);
  const terminal = await Promise.race([
    harness.finishedSignal.promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('scheduled chat stayed running')), 1000)),
  ]);
  assert.equal(terminal.ok, false, 'outer scheduler should surface the storage failure');
  assert.equal(harness.finished.length, 1, 'shadow task must still receive exactly one terminal event');
});
