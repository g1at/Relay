'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskEventJournal } = require('../src/main/tasks/task-event-journal');

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

test('replayEpoch 当前实例完全沿用实时 replay，旧实例按 runId 分页且不改日志或元数据', t => {
  const { journal: old, rootDir } = makeJournal(t, { epoch: 'old-instance' });
  old.appendMany(['other', 'wanted', 'other', 'wanted', 'wanted'].map((runId, index) => ({
    type: 'claude.event', runId, payload: { text: `Synthetic ${index}` },
  })));
  old.ack(3);
  const { journal } = makeJournal(t, { rootDir, epoch: 'current-instance' });
  journal.append({ type: 'claude.event', runId: 'wanted', payload: { text: 'Current instance' } });
  assert.deepEqual(journal.replayEpoch({ runId: 'wanted' }), journal.replay({ runId: 'wanted' }));
  const before = [old.journalPath, old.metaPath].map(file => ({ file, bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }));
  const first = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', limit: 1 });
  assert.deepEqual(first.events.map(event => event.seq), [2]);
  assert.equal(first.epoch, old.epoch); assert.equal(first.lastSeq, 5); assert.equal(first.ackSeq, 3);
  assert.equal(first.compactedThroughSeq, 0); assert.equal(first.resetRequired, false); assert.equal(first.missing, false);
  assert.equal(first.hasMore, true);
  const second = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', sinceSeq: 2, limit: 2 });
  assert.deepEqual(second.events.map(event => event.seq), [4, 5]); assert.equal(second.hasMore, false);
  assert.equal(journal.replayEpoch({ epoch: old.epoch, runId: 'absent' }).events.length, 0);
  assert.equal(journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', limit: 0 }).hasMore, true);
  assert.equal(journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', sinceSeq: 6 }).resetRequired, true);
  first.events[0].payload.text = 'Caller changed its own copy';
  assert.equal(journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', limit: 1 }).events[0].payload.text, 'Synthetic 1');
  for (const entry of before) {
    assert.deepEqual(fs.readFileSync(entry.file), entry.bytes);
    assert.equal(fs.statSync(entry.file).mtimeMs, entry.mtime);
  }
  assert.equal(journal.lastSeq, 1, 'Archived replay must not change the current stream cursor');
});

test('replayEpoch 拒绝跨目录和无任务范围的归档读取，缺失文件明确返回 missing', t => {
  const { journal } = makeJournal(t);
  for (const epoch of ['../outside', '/tmp/outside', 'a/b', 'a\\b', '..']) {
    assert.throws(() => journal.replayEpoch({ epoch, runId: 'wanted' }), { code: 'INVALID_EPOCH' });
  }
  for (const runId of [undefined, '../other', 'bad/id']) {
    assert.throws(() => journal.replayEpoch({ epoch: 'old', runId }), { code: 'INVALID_RUN_ID' });
  }
  assert.throws(() => journal.replayEpoch({ epoch: 'old', runId: 'wanted', sinceSeq: -1 }), { code: 'INVALID_SEQUENCE' });
  assert.throws(() => journal.replayEpoch([]), { code: 'INVALID_REPLAY_OPTIONS' });
  assert.deepEqual(journal.replayEpoch({ epoch: 'missing-instance', runId: 'wanted' }), {
    epoch: 'missing-instance', sinceSeq: 0, lastSeq: 0, ackSeq: 0, compactedThroughSeq: 0,
    resetRequired: true, missing: true, hasMore: false, events: [],
  });
  fs.mkdirSync(path.join(journal.epochsDir, 'directory.jsonl'));
  assert.throws(() => journal.replayEpoch({ epoch: 'directory', runId: 'wanted' }), { code: 'INVALID_ARCHIVED_JOURNAL' });
});

test('replayEpoch 保留损坏尾部之前的有效过程，不修写旧文件或相信超前元数据', t => {
  const { journal: old, rootDir } = makeJournal(t, { epoch: 'crashed-instance' });
  old.appendMany([1, 2].map(index => ({ type: 'claude.event', runId: 'wanted', payload: { index } })));
  fs.appendFileSync(old.journalPath, '{"partial":');
  fs.writeFileSync(old.metaPath, JSON.stringify({ ...old.metadata(), lastSeq: 999, ackSeq: 999 }));
  const { journal } = makeJournal(t, { rootDir, epoch: 'new-instance' });
  const before = fs.readFileSync(old.journalPath), meta = fs.readFileSync(old.metaPath);
  const replay = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted' });
  assert.deepEqual(replay.events.map(event => event.seq), [1, 2]);
  assert.equal(replay.lastSeq, 2); assert.equal(replay.ackSeq, 2);
  assert.equal(replay.damagedTail, true); assert.equal(replay.resetRequired, true);
  assert.deepEqual(fs.readFileSync(old.journalPath), before); assert.deepEqual(fs.readFileSync(old.metaPath), meta);
});

test('replayEpoch 接受无结尾换行的完整事件，缺失元数据不影响过程恢复', t => {
  const { journal: old, rootDir } = makeJournal(t, { epoch: 'no-newline' });
  old.append({ type: 'claude.event', runId: 'wanted', payload: { text: '完整中文回执' } });
  fs.writeFileSync(old.journalPath, fs.readFileSync(old.journalPath, 'utf8').trimEnd());
  fs.rmSync(old.metaPath);
  const { journal } = makeJournal(t, { rootDir, epoch: 'new-instance' });
  const before = fs.readFileSync(old.journalPath);
  const replay = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted' });
  assert.equal(replay.events[0].payload.text, '完整中文回执');
  assert.equal(replay.damagedTail, false); assert.equal(replay.resetRequired, false);
  assert.equal(replay.lastSeq, 1); assert.equal(replay.ackSeq, 0);
  assert.deepEqual(fs.readFileSync(old.journalPath), before); assert.equal(fs.existsSync(old.metaPath), false);
});

test('replayEpoch 遇到序号断层或串入其他 epoch 后停止，不把后续记录拼接成完整过程', t => {
  const { journal: old, rootDir } = makeJournal(t, { epoch: 'old-instance' });
  const first = old.append({ type: 'claude.event', runId: 'wanted', payload: { text: 'Valid prefix' } });
  const { journal } = makeJournal(t, { rootDir, epoch: 'new-instance' });
  for (const damaged of [{ ...first, seq: 3 }, { ...first, seq: 2, epoch: 'foreign' }, { ...first, seq: 2, runId: '../escape' }]) {
    fs.writeFileSync(old.journalPath, [first, damaged, { ...first, seq: 4 }].map(event => JSON.stringify(event)).join('\n') + '\n');
    const replay = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted' });
    assert.deepEqual(replay.events.map(event => event.seq), [1]);
    assert.equal(replay.lastSeq, 1); assert.equal(replay.damagedTail, true); assert.equal(replay.hasMore, false);
  }
});

test('replayEpoch 正确标记被保留窗口裁掉的前缀和已确认的空归档', t => {
  const { journal: old, rootDir } = makeJournal(t, { epoch: 'compacted-instance' });
  old.appendMany([1, 2, 3, 4, 5].map(index => ({ type: 'claude.event', runId: 'wanted', payload: { index } })));
  old.ack(3); old.compact();
  const { journal } = makeJournal(t, { rootDir, epoch: 'new-instance' });
  const partial = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted' });
  assert.equal(partial.compactedThroughSeq, 3); assert.equal(partial.lastSeq, 5); assert.equal(partial.resetRequired, true);
  assert.deepEqual(partial.events.map(event => event.seq), [4, 5]);
  assert.equal(journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', sinceSeq: 3 }).resetRequired, false);
  old.ack(5); old.compact();
  const empty = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted' });
  assert.equal(empty.missing, false); assert.equal(empty.lastSeq, 5); assert.equal(empty.compactedThroughSeq, 5);
  assert.equal(empty.ackSeq, 5); assert.equal(empty.resetRequired, true); assert.deepEqual(empty.events, []);
  assert.equal(journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', sinceSeq: 5 }).resetRequired, false);
});

test('replayEpoch 多页复用只读索引，只解析本页且文件变化后刷新缓存', t => {
  const { journal: old, rootDir } = makeJournal(t, { epoch: 'cached-instance' });
  old.appendMany(Array.from({ length: 30 }, (_, index) => ({ type: 'claude.event', runId: index % 2 ? 'other' : 'wanted', payload: { index } })));
  const { journal } = makeJournal(t, { rootDir, epoch: 'new-instance' });
  const originalRead = fs.readFileSync, originalParse = JSON.parse;
  let reads = 0, eventParses = 0;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === old.journalPath) reads++;
    return originalRead.call(this, file, ...args);
  });
  t.mock.method(JSON, 'parse', function(text, ...args) {
    if (typeof text === 'string' && text.includes('"type":"claude.event"') && text.includes('"epoch":"cached-instance"')) eventParses++;
    return originalParse.call(this, text, ...args);
  });
  const first = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', limit: 1 });
  assert.equal(reads, 1); assert.equal(eventParses, 31);
  const second = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', sinceSeq: first.events[0].seq, limit: 2 });
  assert.deepEqual(second.events.map(event => event.seq), [3, 5]);
  assert.equal(reads, 1); assert.equal(eventParses, 33, 'Stable archive pagination only parses returned records');
  const last = { ...first.events[0], seq: 31, payload: { index: 'later' } };
  fs.appendFileSync(old.journalPath, JSON.stringify(last) + '\n');
  const refreshed = journal.replayEpoch({ epoch: old.epoch, runId: 'wanted', sinceSeq: 30 });
  assert.equal(reads, 2); assert.equal(refreshed.lastSeq, 31); assert.equal(refreshed.events[0].payload.index, 'later');
});

test('replayEpoch 归档缓存按 epoch 有界淘汰，读取不会清理其他磁盘 epoch', t => {
  const rootDir = makeRoot(t), epochs = ['archive-a', 'archive-b', 'archive-c'];
  for (const epoch of epochs) {
    const { journal } = makeJournal(t, { rootDir, epoch });
    journal.append({ type: 'claude.event', runId: 'wanted' });
  }
  const { journal } = makeJournal(t, { rootDir, epoch: 'new-instance' });
  const filesBefore = fs.readdirSync(journal.epochsDir).sort();
  const originalRead = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (String(file).endsWith('archive-a.jsonl')) reads++;
    return originalRead.call(this, file, ...args);
  });
  for (const epoch of epochs) journal.replayEpoch({ epoch, runId: 'wanted' });
  assert.equal(reads, 1);
  journal.replayEpoch({ epoch: 'archive-a', runId: 'wanted' });
  assert.equal(reads, 2);
  assert.deepEqual(fs.readdirSync(journal.epochsDir).sort(), filesBefore);
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
