'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationScratch } = require('../src/main/projects/conversation-scratch');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-migration-atomicity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const id = 'migration-owner', records = {}, legacyRoot = path.join(home, 'source');
  let historyReads = 0;
  const options = {
    legacyRoot, getRoot: () => legacyRoot, folderFor: value => value,
    readRecords: () => records, saveRecords: () => {},
    loadConversation: () => null,
    loadConversationForCleanup: () => { historyReads++; throw Error('Migration must not scan histories'); },
  };
  const source = createConversationScratch(options).resolve(id);
  fs.writeFileSync(path.join(source, 'source.txt'), 'authoritative source');
  const root = path.join(home, 'target'), token = 'c'.repeat(32);
  const targetDir = path.join(root, id), stagingDir = path.join(root, '.relay-migrate-' + id + '-' + token);
  const markerName = '.relay-migration-' + token + '.json';
  const marker = { version: 1, conversationId: id, token, source, target: targetDir };
  for (const dir of [stagingDir, targetDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, markerName), JSON.stringify(marker));
    fs.writeFileSync(path.join(dir, 'copy.txt'), dir === stagingDir ? 'staging copy' : 'target copy');
  }
  records[id].scratchMigration = {
    token, root, realRoot: fs.realpathSync(root), sourceDir: source, stagingDir, targetDir,
  };
  const before = JSON.stringify(records[id]);
  // A fresh instance exercises recovery after an interrupted process.
  const scratch = createConversationScratch(options);
  return { home, id, records, source, root, targetDir, stagingDir, markerName, marker,
    before, scratch, historyReads: () => historyReads };
}

function assertCopiesRetained(f) {
  assert.equal(fs.readFileSync(path.join(f.source, 'source.txt'), 'utf8'), 'authoritative source');
  assert.equal(fs.readFileSync(path.join(f.stagingDir, 'copy.txt'), 'utf8'), 'staging copy');
  assert.equal(fs.readFileSync(path.join(f.targetDir, 'copy.txt'), 'utf8'), 'target copy');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.stagingDir, f.markerName), 'utf8')), f.marker);
  assert.equal(JSON.stringify(f.records[f.id]), f.before, 'failed preflight must keep the recovery journal and current mapping');
  assert.equal(f.historyReads(), 0);
}

test('recovery retains both copies when the second migration marker is invalid', async t => {
  const f = fixture(t);
  const invalidMarker = { ...f.marker, token: 'd'.repeat(32) };
  fs.writeFileSync(path.join(f.targetDir, f.markerName), JSON.stringify(invalidMarker));
  await assert.rejects(f.scratch.migrate(f.id, f.root), /迁移目标所有权不匹配/);
  assertCopiesRetained(f);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.targetDir, f.markerName), 'utf8')), invalidMarker);
});

test('recovery preflights every copy before removing the first when the second covers another output', async t => {
  const f = fixture(t);
  const outputDir = path.join(f.targetDir, 'protected-output');
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, 'report.txt'), 'other conversation result');
  f.records.other = { cwd: f.home, outputDir };
  const otherBefore = JSON.stringify(f.records.other);
  await assert.rejects(f.scratch.migrate(f.id, f.root), {
    code: 'CONVERSATION_FILES_NOT_OWNED', cleanupUnchanged: true,
  });
  assertCopiesRetained(f);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.targetDir, f.markerName), 'utf8')), f.marker);
  assert.equal(fs.readFileSync(path.join(outputDir, 'report.txt'), 'utf8'), 'other conversation result');
  assert.equal(JSON.stringify(f.records.other), otherBefore);
});
