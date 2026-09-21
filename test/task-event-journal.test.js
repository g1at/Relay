'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskEventJournal } = require('../task-event-journal');

function makeRoot(t) {
  let rootDir;
  try {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-task-events-'));
  } catch (_) {
    const fallback = path.join(__dirname, '.task-event-journal-tmp');
    fs.mkdirSync(fallback, { recursive: true });
    rootDir = fs.mkdtempSync(path.join(fallback, 'journal-'));
  }
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function makeJournal(t, overrides = {}) {
  const rootDir = overrides.rootDir || makeRoot(t);
  let tick = 0;
  const journal = new TaskEventJournal({
    rootDir,
    epoch: 'epoch-test',
    now: () => new Date(Date.UTC(2026, 7, 25, 0, 0, tick++)),
    logger: { warn() {} },
    ...overrides,
  });
  return { journal, rootDir };
}

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('append 分配同一 epoch 内连续 seq，重启后从 JSONL 恢复序号', (t) => {
  const { journal, rootDir } = makeJournal(t);
  const first = journal.append({
    type: 'run.upsert',
    runId: 'run-one',
    revision: 1,
    payload: { run: { title: '第一项' } },
  });
  const second = journal.append({
    type: 'run.activity',
    runId: 'run-one',
    payload: { text: '正在执行' },
  });

  assert.equal(first.epoch, 'epoch-test');
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(readLines(journal.journalPath), [first, second]);
  assert.equal(fs.readdirSync(path.dirname(journal.metaPath)).some((name) => name.endsWith('.tmp')), false);

  const reopened = new TaskEventJournal({
    rootDir,
    epoch: 'epoch-test',
    now: () => new Date('2026-08-26T00:00:00Z'),
    logger: { warn() {} },
  });
  assert.equal(reopened.lastSeq, 2);
  assert.equal(reopened.append({ type: 'run.upsert', payload: {} }).seq, 3);
});

test('append 深度复制并脱敏敏感字段、凭据文本、错误与循环引用', (t) => {
  const { journal } = makeJournal(t);
  const payload = {
    authorization: 'Bearer top-secret',
    headers: { Authorization: 'Bearer header-secret', cookie: 'sid=secret' },
    url: 'https://example.test/cb?access_token=url-secret&ok=1',
    output: 'created with sk-ant-abcdefghijklmnopqrstuvwxyz123456',
    error: new Error('request Authorization: Bearer error-secret failed'),
    binary: Buffer.from('secret bytes'),
  };
  payload.self = payload;
  const stored = journal.append({ type: 'run.activity', runId: 'redacted-run', payload });

  assert.equal(stored.payload.authorization, '[REDACTED]');
  assert.equal(stored.payload.headers.Authorization, '[REDACTED]');
  assert.equal(stored.payload.headers.cookie, '[REDACTED]');
  assert.equal(stored.payload.url.includes('url-secret'), false);
  assert.equal(stored.payload.output.includes('sk-ant-'), false);
  assert.equal(stored.payload.error.message.includes('error-secret'), false);
  assert.equal(stored.payload.binary, '[Binary 12 bytes]');
  assert.equal(stored.payload.self, '[Circular]');
  assert.equal(payload.authorization, 'Bearer top-secret');
});

test('replay 支持 sinceSeq、分页与 epoch 不匹配时要求重新取快照', (t) => {
  const { journal } = makeJournal(t);
  for (let index = 1; index <= 5; index += 1) {
    journal.append({ type: 'run.activity', runId: 'replay-run', payload: { index } });
  }

  const page = journal.replay({ epoch: 'epoch-test', sinceSeq: 2, limit: 2 });
  assert.deepEqual(page.events.map((event) => event.seq), [3, 4]);
  assert.equal(page.hasMore, true);
  assert.equal(page.lastSeq, 5);
  assert.equal(page.resetRequired, false);
  assert.deepEqual(journal.replay({ sinceSeq: 2, limit: 0 }).events, []);

  const wrongEpoch = journal.replay({ epoch: 'old-epoch', sinceSeq: 2 });
  assert.deepEqual(wrongEpoch.events, []);
  assert.equal(wrongEpoch.epoch, 'epoch-test');
  assert.equal(wrongEpoch.resetRequired, true);
});

test('ack 单调且持久，compact 原子移除已确认前缀并保留连续重放', (t) => {
  const { journal, rootDir } = makeJournal(t);
  for (let index = 1; index <= 5; index += 1) {
    journal.append({ type: 'run.activity', payload: { index } });
  }
  journal.ack({ epoch: 'epoch-test', seq: 3 });
  journal.ack(2);
  assert.equal(journal.ackSeq, 3);

  const compacted = journal.compact();
  assert.equal(compacted.compactedThroughSeq, 3);
  assert.deepEqual(readLines(journal.journalPath).map((event) => event.seq), [4, 5]);
  assert.equal(journal.replay({ sinceSeq: 0 }).resetRequired, true);
  assert.deepEqual(journal.replay({ sinceSeq: 3 }).events.map((event) => event.seq), [4, 5]);

  const reopened = new TaskEventJournal({
    rootDir,
    epoch: 'epoch-test',
    logger: { warn() {} },
  });
  assert.equal(reopened.lastSeq, 5);
  assert.equal(reopened.ackSeq, 3);
  assert.equal(reopened.compactedThroughSeq, 3);
  assert.equal(fs.readdirSync(path.dirname(journal.metaPath)).some((name) => name.endsWith('.tmp')), false);
});

test('启动时丢弃损坏尾行，随后 append 不会与半行粘连', (t) => {
  const warnings = [];
  const { journal, rootDir } = makeJournal(t, { logger: { warn: (message) => warnings.push(message) } });
  journal.append({ type: 'run.upsert', payload: { index: 1 } });
  journal.append({ type: 'run.upsert', payload: { index: 2 } });
  fs.appendFileSync(journal.journalPath, '{"schemaVersion":1,"epoch":"epoch-test"', 'utf8');

  const reopened = new TaskEventJournal({
    rootDir,
    epoch: 'epoch-test',
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(reopened.lastSeq, 2);
  assert.deepEqual(reopened.replay(0).events.map((event) => event.seq), [1, 2]);
  assert.equal(reopened.append({ type: 'run.upsert', payload: { index: 3 } }).seq, 3);
  assert.deepEqual(readLines(reopened.journalPath).map((event) => event.seq), [1, 2, 3]);
  assert.equal(warnings.some((message) => message.includes('damaged journal tail')), true);
});

test('完整尾行即使缺少换行也会先修复再追加', (t) => {
  const { journal, rootDir } = makeJournal(t);
  journal.append({ type: 'run.upsert', payload: { index: 1 } });
  const withoutNewline = fs.readFileSync(journal.journalPath, 'utf8').trimEnd();
  fs.writeFileSync(journal.journalPath, withoutNewline, 'utf8');

  const reopened = new TaskEventJournal({
    rootDir,
    epoch: 'epoch-test',
    logger: { warn() {} },
  });
  reopened.append({ type: 'run.upsert', payload: { index: 2 } });
  assert.deepEqual(readLines(reopened.journalPath).map((event) => event.seq), [1, 2]);
});

test('maxEvents 自动限制保留窗口，seq 继续递增并提示旧游标重置', (t) => {
  const { journal } = makeJournal(t, { maxEvents: 3, maxBytes: 1024 * 1024 });
  for (let index = 1; index <= 7; index += 1) {
    journal.append({ type: 'run.activity', payload: { index } });
  }

  assert.equal(journal.lastSeq, 7);
  assert.equal(journal.eventCount, 3);
  assert.deepEqual(journal.replay({ sinceSeq: 4 }).events.map((event) => event.seq), [5, 6, 7]);
  assert.equal(journal.replay({ sinceSeq: 3 }).resetRequired, true);
  assert.equal(journal.compactedThroughSeq, 4);
});

test('appendMany 为整批事件分配连续序号并一次提交可重放记录', (t) => {
  const { journal } = makeJournal(t);
  const stored = journal.appendMany([
    { type: 'claude.event', runId: 'batch-run', payload: { index: 1 } },
    { type: 'claude.event', runId: 'batch-run', payload: { index: 2 } },
    { type: 'claude.event', runId: 'batch-run', payload: { index: 3 } },
  ]);
  assert.deepEqual(stored.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(journal.replay(0).events.map((event) => event.payload.index), [1, 2, 3]);
  assert.equal(journal.metadata().eventCount, 3);
});

test('replay 在分页前按 runId 过滤，避免其它任务占满页面', (t) => {
  const { journal } = makeJournal(t);
  journal.appendMany([
    { type: 'claude.event', runId: 'other-run', payload: { index: 1 } },
    { type: 'claude.event', runId: 'wanted-run', payload: { index: 2 } },
    { type: 'claude.event', runId: 'other-run', payload: { index: 3 } },
    { type: 'claude.event', runId: 'wanted-run', payload: { index: 4 } },
  ]);
  const replay = journal.replay({ sinceSeq: 0, limit: 1, runId: 'wanted-run' });
  assert.deepEqual(replay.events.map((event) => event.payload.index), [2]);
  assert.equal(replay.hasMore, true);
});

test('maxEpochs 清理最旧 epoch 的日志和元数据', (t) => {
  const rootDir = makeRoot(t);
  for (let index = 1; index <= 4; index += 1) {
    const journal = new TaskEventJournal({
      rootDir,
      epoch: `epoch-${index}`,
      maxEpochs: 3,
      now: () => new Date(Date.UTC(2026, 7, 25, 0, 0, index)),
      logger: { warn() {} },
    });
    journal.append({ type: 'run.upsert', payload: { index } });
  }
  const names = fs.readdirSync(path.join(rootDir, 'epochs'));
  assert.equal(names.includes('epoch-1.jsonl'), false);
  assert.equal(names.includes('epoch-1.meta.json'), false);
  assert.equal(names.filter((name) => name.endsWith('.jsonl')).length, 3);
});
