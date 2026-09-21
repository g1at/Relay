'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { CheckpointManager } = require('../checkpoint-manager');

function fixture(t) {
  let base = os.tmpdir();
  try { fs.accessSync(base, fs.constants.W_OK); }
  catch (_) { base = '/tmp'; }
  const root = fs.mkdtempSync(path.join(base, 'relay-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, manager: new CheckpointManager({ rootDir: path.join(root, 'store') }) };
}

test('预览保存文件统计，真实回退只能消费已附着的 SDK 会话', async (t) => {
  const { root, manager } = fixture(t);
  const file = path.join(root, 'note.txt');
  fs.writeFileSync(file, 'after', 'utf8');
  const calls = [];
  manager.register({
    runId: 'run-checkpoint',
    userMessageId: '11111111-1111-4111-8111-111111111111',
    conversationId: 'conv-1',
  });
  manager.attach('run-checkpoint', {
    async rewindFiles(id, options) {
      calls.push({ id, options });
      if (!options.dryRun) fs.writeFileSync(file, 'before', 'utf8');
      return { canRewind: true, filesChanged: [file], insertions: 1, deletions: 1, skippedLinks: 0 };
    },
  });

  const preview = await manager.preview('run-checkpoint');
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.preview.filesChanged, [file]);
  const rolled = await manager.rollback('run-checkpoint');
  assert.equal(rolled.status, 'rolled_back');
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.deepEqual(calls.map((call) => call.options.dryRun), [true, false]);
});

test('预览后发生外部修改时阻止覆盖', async (t) => {
  const { root, manager } = fixture(t);
  const file = path.join(root, 'changed.txt');
  fs.writeFileSync(file, 'task result', 'utf8');
  manager.register({
    runId: 'run-conflict',
    userMessageId: '22222222-2222-4222-8222-222222222222',
  });
  let realRewind = false;
  manager.attach('run-conflict', {
    async rewindFiles(_id, options) {
      if (!options.dryRun) realRewind = true;
      return { canRewind: true, filesChanged: [file] };
    },
  });
  await manager.preview('run-conflict');
  fs.writeFileSync(file, 'edited later', 'utf8');
  await assert.rejects(
    manager.rollback('run-conflict'),
    (error) => error.code === 'CHECKPOINT_CONFLICT' && error.conflicts[0] === file,
  );
  assert.equal(realRewind, false);
});

test('进程重启后记录仍可查看但不会伪装成可回退', async (t) => {
  const { root, manager } = fixture(t);
  manager.register({
    runId: 'run-restart',
    userMessageId: '33333333-3333-4333-8333-333333333333',
  });
  const restarted = new CheckpointManager({ rootDir: path.join(root, 'store') });
  const result = await restarted.preview('run-restart');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.available, false);
  assert.match(result.unavailableReason, /无法再通过 Relay 一键撤销/);
});

test('预览控制通道不回包时有界失败、释放适配器并标记不可回退', async (t) => {
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = fs.mkdtempSync(path.join(tempRoot, 'relay-checkpoint-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new CheckpointManager({
    rootDir: path.join(root, 'store'),
    previewTimeoutMs: 20,
  });
  manager.register({
    runId: 'run-timeout',
    userMessageId: '44444444-4444-4444-8444-444444444444',
    workspace: root,
  });
  let aborted = 0;
  manager.attach('run-timeout', {
    rewindFiles: () => new Promise(() => {}),
    abort: () => { aborted += 1; },
  });

  await assert.rejects(manager.preview('run-timeout'), (error) => error.code === 'CHECKPOINT_PREVIEW_TIMEOUT');
  const record = manager.publicRecord(manager.get('run-timeout'));
  assert.equal(aborted, 1);
  assert.equal(record.status, 'unavailable');
  assert.equal(record.available, false);
  assert.match(record.unavailableReason, /预览超时/);
});

test('预览文件指纹阶段不回包也受同一 deadline 约束', async (t) => {
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = fs.mkdtempSync(path.join(tempRoot, 'relay-checkpoint-hash-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'offline-share.txt');
  fs.writeFileSync(file, 'content', 'utf8');
  const manager = new CheckpointManager({
    rootDir: path.join(root, 'store'),
    previewTimeoutMs: 100,
    fileHashAsync: () => new Promise(() => {}),
  });
  manager.register({
    runId: 'run-hash-timeout',
    userMessageId: '55555555-5555-4555-8555-555555555555',
    workspace: root,
  });
  let aborted = 0;
  manager.attach('run-hash-timeout', {
    rewindFiles: async () => ({ canRewind: true, filesChanged: [file] }),
    abort: () => { aborted += 1; },
  });

  await assert.rejects(
    manager.preview('run-hash-timeout'),
    (error) => error.code === 'CHECKPOINT_PREVIEW_TIMEOUT',
  );
  const record = manager.publicRecord(manager.get('run-hash-timeout'));
  assert.equal(aborted, 1);
  assert.equal(record.status, 'unavailable');
  assert.equal(record.preview, null);
  assert.equal(record.available, false);
});

test('真实回退超时后等待执行器关闭，并阻止迟到结果覆盖不确定状态', async (t) => {
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = fs.mkdtempSync(path.join(tempRoot, 'relay-checkpoint-rollback-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollback.txt');
  fs.writeFileSync(file, 'after', 'utf8');
  const manager = new CheckpointManager({
    rootDir: path.join(root, 'store'),
    rollbackTimeoutMs: 100,
  });
  manager.register({
    runId: 'run-rollback-timeout',
    userMessageId: '66666666-6666-4666-8666-666666666666',
    workspace: root,
  });
  let resolveLateRewind;
  let abortFinished = false;
  manager.attach('run-rollback-timeout', {
    rewindFiles: async (_id, options) => {
      if (options.dryRun) return { canRewind: true, filesChanged: [file] };
      return new Promise((resolve) => { resolveLateRewind = resolve; });
    },
    abort: () => new Promise((resolve) => {
      setTimeout(() => {
        abortFinished = true;
        resolve({ stopConfirmed: true });
      }, 40);
    }),
  });
  await manager.preview('run-rollback-timeout');

  const startedAt = Date.now();
  await assert.rejects(
    manager.rollback('run-rollback-timeout'),
    (error) => error.code === 'ROLLBACK_OUTCOME_UNKNOWN' && error.holdCheckpointLock === false,
  );
  assert.equal(abortFinished, true);
  assert.ok(Date.now() - startedAt >= 120, 'rollback must wait for abort acknowledgement');
  let record = manager.publicRecord(manager.get('run-rollback-timeout'));
  assert.equal(record.status, 'unavailable');
  assert.match(record.unavailableReason, /结果不确定/);

  resolveLateRewind({ canRewind: true, filesChanged: [file] });
  await new Promise((resolve) => setImmediate(resolve));
  record = manager.publicRecord(manager.get('run-rollback-timeout'));
  assert.equal(record.status, 'unavailable');
  assert.equal(record.rollback, null);
});

test('执行器明确返回未停止时保留工作区锁语义', async (t) => {
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = fs.mkdtempSync(path.join(tempRoot, 'relay-checkpoint-stop-failed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'uncertain.txt');
  fs.writeFileSync(file, 'after', 'utf8');
  const manager = new CheckpointManager({
    rootDir: path.join(root, 'store'),
    rollbackTimeoutMs: 100,
    abortConfirmationTimeoutMs: 100,
  });
  manager.register({
    runId: 'run-stop-failed',
    userMessageId: '77777777-7777-4777-8777-777777777777',
    workspace: root,
  });
  manager.attach('run-stop-failed', {
    rewindFiles: async (_id, options) => (options.dryRun
      ? { canRewind: true, filesChanged: [file] }
      : new Promise(() => {})),
    abort: async () => ({ stopConfirmed: false }),
  });
  await manager.preview('run-stop-failed');

  let caught;
  try { await manager.rollback('run-stop-failed'); }
  catch (error) { caught = error; }
  assert.equal(caught.code, 'ROLLBACK_OUTCOME_UNKNOWN');
  assert.equal(caught.holdCheckpointLock, true);
  assert.equal(caught.releaseCheckpointLockWhen, undefined);
  assert.match(manager.get('run-stop-failed').unavailableReason, /保持锁定/);
});

test('关闭确认本身不回包时 IPC 可终态返回，迟到确认可用于安全解锁', async (t) => {
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = fs.mkdtempSync(path.join(tempRoot, 'relay-checkpoint-stop-late-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'late-stop.txt');
  fs.writeFileSync(file, 'after', 'utf8');
  const manager = new CheckpointManager({
    rootDir: path.join(root, 'store'),
    rollbackTimeoutMs: 100,
    abortConfirmationTimeoutMs: 100,
  });
  manager.register({
    runId: 'run-stop-late',
    userMessageId: '88888888-8888-4888-8888-888888888888',
    workspace: root,
  });
  let confirmStop;
  manager.attach('run-stop-late', {
    rewindFiles: async (_id, options) => (options.dryRun
      ? { canRewind: true, filesChanged: [file] }
      : new Promise(() => {})),
    abort: () => new Promise((resolve) => { confirmStop = resolve; }),
  });
  await manager.preview('run-stop-late');

  const startedAt = Date.now();
  let caught;
  try { await manager.rollback('run-stop-late'); }
  catch (error) { caught = error; }
  const elapsed = Date.now() - startedAt;
  assert.equal(caught.code, 'ROLLBACK_OUTCOME_UNKNOWN');
  assert.equal(caught.holdCheckpointLock, true);
  assert.equal(typeof caught.releaseCheckpointLockWhen.then, 'function');
  assert.ok(elapsed >= 180 && elapsed < 1000, 'rollback and stop-confirm waits must both be bounded');

  confirmStop({ stopConfirmed: true });
  assert.equal(await caught.releaseCheckpointLockWhen, true);
});
