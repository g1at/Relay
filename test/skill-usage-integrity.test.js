'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
function scan(projectsRoot, previous = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '../src/main/skills/skill-usage-worker.js'), { workerData: { projectsRoot, previous } });
    worker.once('message', resolve); worker.once('error', reject);
    worker.once('exit', code => { if (code) reject(new Error(`Worker exited ${code}`)); });
  });
}
test('telemetry completeness requires readable roots and parseable complete files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-usage-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = await scan(path.join(root, 'missing'));
  assert.equal(missing.complete, false); assert.equal(missing.integrity.directoryErrors, 1);
  assert.equal(JSON.stringify(missing.integrity).includes(root), false);
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, '{"type":"user","message":{"content":"hello"}}\n');
  const good = await scan(root); assert.equal(good.complete, true);
  const cached = await scan(root, good.index); assert.equal(cached.complete, true); assert.equal(cached.scannedFiles, 0);
  delete good.index.files['session.jsonl'].complete;
  const legacy = await scan(root, good.index); assert.equal(legacy.complete, true); assert.equal(legacy.scannedFiles, 1);
  fs.appendFileSync(file, '{broken\n');
  const bad = await scan(root, legacy.index); assert.equal(bad.complete, false); assert.equal(bad.integrity.parseErrors, 1);
  const stillBad = await scan(root, bad.index); assert.equal(stillBad.complete, false);
  fs.writeFileSync(file, '{"type":"user","message":');
  const tail = await scan(root); assert.equal(tail.complete, false); assert.equal(tail.integrity.incompleteFiles, 1);
  fs.writeFileSync(file, '{"type":"user","message":{}}');
  assert.equal((await scan(root, tail.index)).complete, true);
});
