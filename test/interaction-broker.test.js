'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  INTERACTION_EVENTS,
  InteractionBroker,
  InteractionBrokerError,
  sanitizeForRenderer,
  isAppPermissionMode,
  normalizeAppPermissionMode,
  resolveUnattendedPermissionMode,
} = require('../src/main/tasks/interaction-broker');

test('老用户原有工具权限保持不变，新安装才默认逐项确认', () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
    assert.equal(isAppPermissionMode(mode), true);
    assert.equal(normalizeAppPermissionMode(mode, { hasExistingSettings: true }), mode);
  }
  assert.equal(normalizeAppPermissionMode(undefined, { hasExistingSettings: true }), 'bypassPermissions');
  assert.equal(normalizeAppPermissionMode(undefined, { hasExistingSettings: false }), 'default');
  assert.equal(normalizeAppPermissionMode('invalid', { hasExistingSettings: true }), 'default');
});

test('无人值守权限只接受显式应用模式，遗漏或非法值安全回退', () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
    assert.equal(resolveUnattendedPermissionMode(mode), mode);
  }
  for (const mode of [undefined, null, '', 'dontAsk', 'auto', 'invalid']) {
    assert.equal(resolveUnattendedPermissionMode(mode), 'default');
  }
});

function makeBroker(overrides = {}) {
  let id = 0;
  const events = [];
  const broker = new InteractionBroker({
    idFactory: () => `ask-${++id}`,
    defaultTimeoutMs: 60_000,
    onChange: (event) => events.push(event),
    logger: { warn() {} },
    ...overrides,
  });
  return { broker, events };
}

function sdkOptions(overrides = {}) {
  return {
    signal: new AbortController().signal,
    toolUseID: 'tool-use-1',
    requestId: 'request-1',
    ...overrides,
  };
}

function questionInput() {
  return {
    questions: [
      {
        question: '你希望启用哪些功能？',
        header: '功能',
        multiSelect: true,
        options: [
          { label: '搜索', description: '允许联网搜索', preview: 'search preview' },
          { label: '文件', description: '允许读取文件' },
        ],
      },
      {
        question: '使用哪种模式？',
        header: '模式',
        multiSelect: false,
        options: [
          { label: '安全', description: '每次确认' },
          { label: '快速', description: '减少确认' },
        ],
      },
    ],
  };
}

test('权限请求只向 renderer 暴露安全 DTO，不泄漏 SDK 信号、requestId 或规则对象', async (t) => {
  const { broker, events } = makeBroker();
  t.after(() => broker.close());
  const circular = { command: 'npm test', ignored() {} };
  circular.self = circular;
  const permission = broker.registerToolUse({
    toolName: 'Bash',
    input: circular,
    sdkOptions: sdkOptions({
      title: 'Claude 想运行 npm test',
      description: '执行项目测试',
      suggestions: [{
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
        behavior: 'allow',
        destination: 'session',
      }],
    }),
    context: { runId: 'run-1', conversationId: 'conv-1', windowId: 7 },
  });

  const dto = broker.get('ask-1');
  assert.equal(dto.kind, 'permission');
  assert.equal(dto.runId, 'run-1');
  assert.equal(dto.windowId, '7');
  assert.equal(dto.permission.title, 'Claude 想运行 npm test');
  assert.equal(dto.permission.input.command, 'npm test');
  assert.equal(dto.permission.input.self, '…（循环引用）');
  assert.equal('ignored' in dto.permission.input, false);
  assert.equal(dto.permission.canAllowForSession, true);
  assert.equal('requestId' in dto, false);
  assert.equal('suggestions' in dto.permission, false);
  assert.equal('signal' in dto, false);
  assert.equal(events[0].type, INTERACTION_EVENTS.PENDING);

  broker.deny('ask-1');
  assert.equal((await permission).behavior, 'deny');
});

test('仅允许一次返回准确 PermissionResult，同一请求只能响应一次', async () => {
  const { broker } = makeBroker();
  const pending = broker.registerToolUse({
    toolName: 'Write',
    input: { file_path: 'a.txt', content: 'hello' },
    sdkOptions: sdkOptions(),
  });

  assert.equal(broker.respond('ask-1', { action: 'allow_once' }), true);
  assert.deepEqual(await pending, {
    behavior: 'allow',
    toolUseID: 'tool-use-1',
    decisionClassification: 'user_temporary',
  });
  assert.equal(broker.size, 0);
  assert.throws(
    () => broker.respond('ask-1', { action: 'deny' }),
    (error) => error instanceof InteractionBrokerError && error.code === 'INTERACTION_NOT_PENDING',
  );
});

test('本会话允许使用 SDK 全套建议，但强制把规则落在 session 而不是持久设置', async () => {
  const { broker } = makeBroker();
  const suggestions = [
    {
      type: 'addRules',
      rules: [{ toolName: 'Read', ruleContent: '/tmp/**' }],
      behavior: 'allow',
      destination: 'userSettings',
    },
    {
      type: 'addDirectories',
      directories: ['/tmp/project'],
      destination: 'projectSettings',
    },
  ];
  const pending = broker.registerToolUse({
    toolName: 'Read',
    input: { file_path: '/tmp/project/a.txt' },
    sdkOptions: sdkOptions({ suggestions }),
  });

  broker.respond('ask-1', {
    action: 'allow_session',
    // Renderer cannot replace the authoritative suggestions with forged permissions.
    updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
  });
  const result = await pending;
  assert.equal(result.behavior, 'allow');
  assert.equal(result.decisionClassification, 'user_permanent');
  assert.deepEqual(result.updatedPermissions, [
    { ...suggestions[0], rules: [{ ...suggestions[0].rules[0] }], destination: 'session' },
    { ...suggestions[1], directories: ['/tmp/project'], destination: 'session' },
  ]);
});

test('SDK 没有权限建议时禁止伪造“本会话允许”，请求保持待处理', async (t) => {
  const { broker } = makeBroker();
  t.after(() => broker.close());
  broker.registerToolUse({ toolName: 'Bash', input: {}, sdkOptions: sdkOptions() });
  assert.throws(
    () => broker.respond('ask-1', { action: 'allow_session' }),
    (error) => error.code === 'SESSION_PERMISSION_UNAVAILABLE',
  );
  assert.equal(broker.size, 1);
});

test('权限拒绝包含用户拒绝分类和可选中断语义', async () => {
  const { broker } = makeBroker();
  const pending = broker.registerToolUse({
    toolName: 'Bash',
    input: { command: 'shutdown' },
    sdkOptions: sdkOptions(),
  });
  broker.respond('ask-1', { action: 'deny', message: '不执行关机', interrupt: true });
  assert.deepEqual(await pending, {
    behavior: 'deny',
    message: '不执行关机',
    interrupt: true,
    toolUseID: 'tool-use-1',
    decisionClassification: 'user_reject',
  });
});

test('AskUserQuestion 按完整问题文本写回 answers，多选转换为逗号分隔字符串', async () => {
  const { broker } = makeBroker();
  const input = questionInput();
  const pending = broker.registerToolUse({
    toolName: 'AskUserQuestion',
    input,
    sdkOptions: sdkOptions(),
    context: { runId: 'question-run' },
  });

  assert.equal(broker.get('ask-1').question.questions[0].options[0].preview, 'search preview');
  broker.respond('ask-1', {
    action: 'submit',
    answers: {
      '你希望启用哪些功能？': ['搜索', '文件'],
      '使用哪种模式？': '安全',
    },
  });
  assert.deepEqual(await pending, {
    behavior: 'allow',
    updatedInput: {
      questions: input.questions,
      answers: {
        '你希望启用哪些功能？': '搜索, 文件',
        '使用哪种模式？': '安全',
      },
    },
    toolUseID: 'tool-use-1',
    decisionClassification: 'user_temporary',
  });
});

test('提问答案校验失败时不消费请求，用户可以修正后再次提交', async (t) => {
  const { broker } = makeBroker();
  t.after(() => broker.close());
  broker.registerToolUse({
    toolName: 'AskUserQuestion',
    input: questionInput(),
    sdkOptions: sdkOptions(),
  });
  assert.throws(
    () => broker.respond('ask-1', {
      action: 'submit',
      answers: { '你希望启用哪些功能？': ['搜索'] },
    }),
    (error) => error.code === 'MISSING_ANSWER',
  );
  assert.equal(broker.size, 1);
});

test('格式无效的 AskUserQuestion 立即安全拒绝，不创建永远挂起的请求', async () => {
  const { broker, events } = makeBroker();
  const result = await broker.registerToolUse({
    toolName: 'AskUserQuestion',
    input: { questions: [] },
    sdkOptions: sdkOptions(),
  });
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /格式无效/);
  assert.equal(broker.size, 0);
  assert.equal(events.length, 0);
});

test('相同 requestId 重投递时复用 pending promise，结算后重投递复用同一结果', async () => {
  const { broker, events } = makeBroker();
  const args = {
    toolName: 'Read',
    input: { file_path: 'a.txt' },
    sdkOptions: sdkOptions(),
  };
  const first = broker.registerToolUse(args);
  const duplicate = broker.registerToolUse(args);
  assert.strictEqual(duplicate, first);
  assert.equal(events.length, 1);

  broker.respond('ask-1', { action: 'allow_once' });
  const result = await first;
  const replayed = await broker.registerToolUse(args);
  assert.strictEqual(replayed, result);
  assert.equal(events.length, 2);
});

test('AbortSignal、任务清理、窗口清理都会拒绝等待请求', async () => {
  const { broker } = makeBroker();
  const controller = new AbortController();
  const aborted = broker.registerToolUse({
    toolName: 'Bash',
    input: {},
    sdkOptions: sdkOptions({ signal: controller.signal, requestId: 'abort-request' }),
    context: { runId: 'run-abort', windowId: 1 },
  });
  const taskPending = broker.registerToolUse({
    toolName: 'Write',
    input: {},
    sdkOptions: sdkOptions({ requestId: 'task-request', toolUseID: 'task-tool' }),
    context: { runId: 'run-cleanup', windowId: 1 },
  });
  const windowPending = broker.registerToolUse({
    toolName: 'Read',
    input: {},
    sdkOptions: sdkOptions({ requestId: 'window-request', toolUseID: 'window-tool' }),
    context: { runId: 'other-run', windowId: 2 },
  });

  controller.abort();
  assert.equal((await aborted).behavior, 'deny');
  assert.equal((await aborted).interrupt, true);
  assert.equal(broker.rejectTask('run-cleanup'), 1);
  assert.equal((await taskPending).behavior, 'deny');
  assert.equal(broker.rejectWindow(2), 1);
  assert.equal((await windowPending).behavior, 'deny');
  assert.equal(broker.size, 0);
});

test('超时严格 fail-closed，只产生 deny，且发送已解决事件', async () => {
  let timeoutCallback;
  const { broker, events } = makeBroker({
    defaultTimeoutMs: 1234,
    setTimeout(callback, delay) {
      assert.equal(delay, 1234);
      timeoutCallback = callback;
      return { fake: true };
    },
    clearTimeout() {},
  });
  const pending = broker.registerToolUse({
    toolName: 'Bash',
    input: { command: 'npm publish' },
    sdkOptions: sdkOptions(),
  });
  timeoutCallback();
  const result = await pending;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /超时/);
  assert.equal(events.at(-1).type, INTERACTION_EVENTS.RESOLVED);
  assert.equal(events.at(-1).resolution.action, 'timed_out');
});

test('sanitizeForRenderer 截断深层与超长内容并移除原型污染键', () => {
  const value = JSON.parse('{"safe":"abcdef","__proto__":{"polluted":true}}');
  const result = sanitizeForRenderer(value, { maxStringLength: 3 });
  assert.match(result.safe, /^abc/);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(result, '__proto__'), false);
});
