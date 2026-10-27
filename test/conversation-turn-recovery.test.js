'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Context = require('../renderer/conversation-context');
const Continuity = require('../renderer/task-continuity');
const { recoverConversationTurn: recover, extractNativeUserInput } = require('../src/main/history/conversation-turn-recovery');

// Build a real host envelope from bootstrap's constants. A changed envelope
// must fail this recovery regression instead of silently swallowing user text.
const bootstrap = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const hint = name => vm.runInNewContext(bootstrap.match(new RegExp(`const ${name} =[\\s\\S]*?;(?=\\r?\\n)`))[0] + `\n${name};`);
const ASK = hint('ASK_HINT'), IMAGE = hint('IMAGE_HINT'), FEISHU = hint('FEISHU_HINT');
// Frozen prior envelope: historical transcripts must remain recoverable after
// the current prompt changes, without treating arbitrary quoted text as a hint.
const LEGACY_FEISHU = '\n\n---\n[系统提示] 上面包含飞书(Feishu/Lark)文档链接。请务必使用 feishu-mcp-pro '
  + '提供的 MCP 工具来读取和操作(如 wiki_get_node / doc_fetch / doc_read / doc_create / doc_write / '
  + 'doc_update / bitable_ops / sheet_ops 等)。若这些工具此刻尚未就绪,请稍等片刻后重试调用,'
  + '不要改用 WebFetch、WebSearch 或命令行(curl/Invoke-WebRequest)去抓取网页 —— 飞书文档需要登录鉴权,'
  + '直接抓网页只会拿到登录页,无法获取正文。\n'
  + '重要:飞书 MCP 提供约 50+ 个工具(涵盖文档读写、多维表格、电子表格、日历、任务、知识库等)。'
  + '如果你的工具列表中只看到部分飞书工具(例如只有读取类没有写入类),这是 MCP 工具列表加载延迟导致的,'
  + '请直接尝试调用你需要的工具名称(如 doc_create、doc_write、doc_update 等),不要因为工具列表中暂时'
  + '看不到就放弃或告诉用户工具不可用——工具实际上是存在的,直接调用即可成功。';
const TS = '2026-09-28T09:10:12.672Z';
function fixture() {
  const conversation = { id: 'conversation', title: 'keep title', updatedAt: '2026-09-28T09:01:28.211Z',
    turns: [{ runId: 'old', ts: '2026-09-28T07:04:42.155Z', user: 'old request', assistant: 'old answer',
      assistantTs: '2026-09-28T09:01:28.211Z', status: 'complete', activity: { endedAt: 123 },
      output: { status: 'complete', final: 'old answer' } }] };
  const taskRun = Continuity.begin({ runId: 'new', startedAt: Date.parse(TS) });
  const run = { runId: 'new', source: { conversationId: 'conversation' }, state: 'running',
    metadata: { turnIndex: 1, turnTs: TS, taskRun } };
  return { conversation, run };
}
function native(f, text, extra = {}) {
  return { type: 'user', uuid: f.run.runId, timestamp: '2026-09-28T09:10:13.221Z',
    message: { role: 'user', content: [{ type: 'text', text }] }, ...extra };
}
function bridge(f, user) {
  return Context.build(f.conversation, { turnIndex: f.run.metadata.turnIndex }) + '\n\n' + user + ASK + IMAGE
    + '\n\n---\n[长期记忆] 宿主维护的无敏感测试记忆。';
}
function snapshot(f, extra = {}) {
  return { user: 'new request', files: [], runId: f.run.runId, ts: TS, ...extra };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('restores missing later input independently while preserving the earlier completed turn and every activity timestamp', () => {
  const f = fixture(), rawMessage = native(f, bridge(f, 'Check the actual outcome again.'));
  freeze(f);
  const result = recover({ ...f, rawMessage });
  assert.equal(result.ok, true); assert.equal(result.recovered, true); assert.equal(result.turnIndex, 1);
  assert.notEqual(result.conversation, f.conversation); assert.notEqual(result.conversation.turns, f.conversation.turns);
  assert.equal(result.conversation.turns[0], f.conversation.turns[0]);
  assert.equal(result.conversation.updatedAt, f.conversation.updatedAt);
  const turn = result.conversation.turns[1];
  assert.equal(turn.user, 'Check the actual outcome again.'); assert.equal(turn.assistant, '');
  assert.equal(turn.ts, TS, 'the native timestamp is not the UI send timestamp');
  assert.deepEqual(turn.taskRun, f.run.metadata.taskRun);
  assert.equal(turn.activity, undefined); assert.equal(turn.assistantTs, undefined);
  assert.equal(f.conversation.turns.length, 1);
});

test('authoritative snapshot preserves original files, skill and execution mode without importing stale output', () => {
  const f = fixture();
  f.run.metadata.recoveryTurn = snapshot(f, { files: [{ path: '/fixture/input.txt', name: 'input.txt', size: 3 }],
    skill: { name: 'fixture-skill', callName: 'fixture' }, executionMode: { kind: 'plan' },
    assistant: 'must not import', activity: { startedAt: 999 }, assistantTs: 'must not import' });
  freeze(f);
  const result = recover(f), turn = result.conversation.turns[1];
  assert.equal(result.ok, true); assert.deepEqual(turn.files, f.run.metadata.recoveryTurn.files);
  assert.notEqual(turn.files, f.run.metadata.recoveryTurn.files);
  assert.deepEqual(turn.skill, { name: 'fixture-skill', callName: 'fixture' });
  assert.deepEqual(turn.executionMode, { kind: 'plan' });
  assert.equal(turn.assistant, ''); assert.equal(turn.activity, undefined); assert.equal(turn.assistantTs, undefined);
});

test('caller may provide a trusted snapshot and attachment-only input is preserved', () => {
  const f = fixture(), recoveryTurn = snapshot(f, { user: '', files: [{ path: '/fixture/image.png' }] });
  const result = recover({ ...f, recoveryTurn });
  assert.equal(result.ok, true); assert.equal(result.conversation.turns[1].user, '');
  assert.equal(result.conversation.turns[1].files.length, 1);
});

test('an existing exact identity is idempotent and does not overwrite user text or output', () => {
  const f = fixture();
  f.conversation.turns.push({ ...snapshot(f), assistant: 'already saved', assistantTs: '2026-09-28T10:01:00.000Z' });
  const result = recover({ ...f, recoveryTurn: snapshot(f, { user: 'different' }) });
  assert.equal(result.ok, true); assert.equal(result.recovered, false); assert.equal(result.conversation, f.conversation);
  assert.equal(result.conversation.turns[1].assistant, 'already saved');
});

test('unique timestamp can identify a legacy turn without inventing a duplicate', () => {
  const f = fixture(); f.conversation.turns.push({ ts: TS, user: 'legacy', assistant: 'kept' });
  const result = recover(f); assert.equal(result.ok, true); assert.equal(result.recovered, false);
  assert.equal(result.conversation, f.conversation);
});

test('run-id conflict, timestamp conflict and duplicate identities refuse to target any existing turn', () => {
  for (const extra of [
    [{ runId: 'new', ts: '2026-09-28T09:11:00.000Z' }],
    [{ runId: 'different', ts: TS }],
    [{ runId: 'new', ts: TS }, { runId: 'new', ts: TS }],
  ]) {
    const f = fixture(); f.conversation.turns.push(...extra); const before = JSON.stringify(f);
    const result = recover({ ...f, recoveryTurn: snapshot(f) });
    assert.equal(result.ok, false); assert.equal(result.code, 'RECOVERY_CONFLICT');
    assert.equal(result.conversation, f.conversation); assert.equal(JSON.stringify(f), before);
  }
});

test('a missing run never falls back to the last turn or fills an unproven gap', () => {
  const f = fixture(); f.run.metadata.turnIndex = 4;
  const result = recover({ ...f, recoveryTurn: snapshot(f) });
  assert.equal(result.ok, false); assert.equal(result.code, 'RECOVERY_POSITION');
  assert.equal(result.conversation.turns.length, 1);
});

test('a missing middle turn is inserted only when both neighboring timestamps agree', () => {
  const f = fixture(); const later = { runId: 'later', ts: '2026-09-28T10:00:00.000Z', user: 'later', assistant: 'keep' };
  f.conversation.turns.push(later);
  const result = recover({ ...f, recoveryTurn: snapshot(f) });
  assert.equal(result.ok, true); assert.equal(result.conversation.turns[2], later);
  f.run.metadata.turnIndex = 0;
  assert.equal(recover({ ...f, recoveryTurn: snapshot(f) }).code, 'RECOVERY_CONFLICT');
});

test('cross-conversation runs and mismatched snapshot identities fail without touching history', () => {
  for (const change of [f => { f.run.source.conversationId = 'other'; },
    f => { f.run.metadata.recoveryTurn = snapshot(f, { runId: 'other' }); },
    f => { f.run.metadata.recoveryTurn = snapshot(f, { ts: '2026-09-28T09:10:13.221Z' }); }]) {
    const f = fixture(); change(f); const result = recover(f);
    assert.equal(result.ok, false); assert.equal(result.conversation, f.conversation);
  }
});

test('only the original exact user UUID is accepted, never compaction, tool results or child messages', () => {
  const f = fixture();
  for (const change of [{ uuid: 'other' }, { isCompactSummary: true }, { isVisibleInTranscriptOnly: true },
    { isSidechain: true }, { parent_tool_use_id: 'parent' }, { type: 'assistant' },
    { message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] } }]) {
    assert.equal(recover({ ...f, rawMessage: native(f, 'plain input', change) }).ok, false);
  }
});

test('a changed history prefix fails explicitly instead of choosing the last paragraph', () => {
  const f = fixture(), rawMessage = native(f, bridge(f, 'new original input'));
  f.conversation.turns[0].assistant = 'history changed since submission';
  const result = recover({ ...f, rawMessage });
  assert.equal(result.ok, false); assert.equal(result.code, 'RECOVERY_HISTORY_BOUNDARY');
});

test('a caller may provide the exact saved history prefix for an older history serializer', () => {
  const f = fixture(), historyPrefix = Context.build(f.conversation, { turnIndex: 1 });
  const rawMessage = native(f, bridge(f, 'new original input'));
  f.conversation.turns[0].assistant = 'later repair';
  const result = recover({ ...f, rawMessage, historyPrefix });
  assert.equal(result.ok, true); assert.equal(result.conversation.turns[1].user, 'new original input');
});

test('multiline user content and blank lines survive removal of host hints exactly', () => {
  const f = fixture(), user = 'First paragraph.\n\nSecond paragraph.\n  indented code  ';
  const result = recover({ ...f, rawMessage: native(f, bridge(f, user)) });
  assert.equal(result.conversation.turns[1].user, user);
});

test('current and legacy Feishu envelopes restore the original input with or without bridged history', () => {
  const user = 'Read https://fixture.feishu.cn/docx/example\n\nKeep this paragraph and trailing spaces.  ';
  for (const feishuHint of [FEISHU, LEGACY_FEISHU]) {
    for (const carryHistory of [false, true]) {
      const f = fixture(), request = carryHistory ? bridge(f, user + feishuHint) : user + feishuHint + ASK + IMAGE;
      const result = recover({ ...f, rawMessage: native(f, request) });
      assert.equal(result.ok, true); assert.equal(result.conversation.turns[1].user, user);
    }
  }
});

test('partial, modified or quoted Feishu envelopes never truncate user history', () => {
  for (const feishuHint of [FEISHU, LEGACY_FEISHU]) {
    for (const input of ['request' + feishuHint.slice(0, -1) + ASK + IMAGE,
      'request' + feishuHint + '\nquoted ending' + ASK + IMAGE,
      'request' + feishuHint + feishuHint + ASK + IMAGE]) {
      const f = fixture(), before = JSON.stringify(f.conversation);
      const result = recover({ ...f, rawMessage: native(f, input) });
      assert.equal(result.ok, false); assert.equal(result.code, 'RECOVERY_UNSUPPORTED_ENVELOPE');
      assert.equal(JSON.stringify(f.conversation), before);
    }
  }
});

test('quoted or modified host envelopes are refused instead of truncating user content', () => {
  const f = fixture();
  for (const text of ['quoted:' + ASK + IMAGE + '\nquoted end' + ASK + IMAGE,
    'request' + ASK + IMAGE + '\nunknown suffix', 'request' + ASK,
    '请先调用 Skill 工具加载「fixture」技能，并严格按照该技能处理下面的请求。\n\nactual']) {
    assert.equal(recover({ ...f, rawMessage: native(f, text) }).ok, false);
  }
});

test('plain SDK strings and text arrays are supported; image and omitted attachment content fail explicitly', () => {
  const f = fixture();
  for (const content of ['plain input', [{ type: 'text', text: 'plain input' }],
    [{ type: 'text', text: 'plain' }, { type: 'text', text: 'input' }]]) {
    const result = recover({ ...f, rawMessage: native(f, '', { message: { role: 'user', content } }) });
    assert.equal(result.ok, true);
  }
  for (const content of [[{ type: 'text', text: 'input' }, { type: 'image', source: {} }],
    'input\n\n---\n用户添加了以下文件或文件夹（绝对路径，不改变当前工作目录）。\n- /fixture/input',
    '[用户图片附件内容已省略]']) {
    assert.equal(recover({ ...f, rawMessage: native(f, '', { message: { role: 'user', content } }) }).ok, false);
  }
});

test('invalid task clocks fail and valid resume snapshots retain the original timing and empty user display', () => {
  const f = fixture(); f.run.metadata.taskRun = { ...f.run.metadata.taskRun, resumedFromRunId: 'old' };
  const result = recover({ ...f, recoveryTurn: snapshot(f, { user: '', inputKind: 'resume' }) });
  assert.equal(result.ok, true); assert.equal(result.conversation.turns[1].inputKind, 'resume');
  assert.equal(result.conversation.turns[1].user, '');
  assert.equal(extractNativeUserInput({ ...f, rawMessage: native(f, Continuity.RESUME_PROMPT) }).ok, false);
  f.run.metadata.taskRun.elapsedBeforeMs = -1;
  assert.equal(recover({ ...f, recoveryTurn: snapshot(f) }).code, 'RECOVERY_TASK_CLOCK');
});
