'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createAutomationDownload, MAX_DOWNLOAD_BYTES } = require('../src/main/browser/browser-automation-downloads');
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-download-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const capture = createAutomationDownload({ directory, check: () => {}, timeoutMs: 1000, ...options });
  if (options.arm !== false) capture.arm();
  t.after(() => capture.cancel());
  return { directory, capture };
}
function item(bytes = Buffer.from('verified download')) {
  const value = new EventEmitter(); value.bytes = bytes; value.received = bytes.length; value.total = bytes.length;
  value.getReceivedBytes = () => value.received; value.getTotalBytes = () => value.total;
  value.setSavePath = file => { value.file = file; };
  value.cancel = () => { value.cancelled = true; value.emit('done', {}, 'cancelled'); };
  value.finish = (state = 'completed') => { fs.writeFileSync(value.file, value.bytes); value.emit('done', {}, state); };
  return value;
}
test('completed downloads have independent bytes/hash verification and a unique destination', async t => {
  const { directory, capture } = fixture(t), file = item();
  fs.writeFileSync(path.join(directory, 'result.txt'), 'existing user file');
  assert.equal(capture.accept(file, { filename: 'result.txt', url: 'https://example.test/export' }), true);
  file.finish(); const result = await capture.result;
  assert.equal(result.state, 'completed'); assert.equal(result.size, file.bytes.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(file.bytes).digest('hex'));
  assert.equal(fs.readFileSync(result.path, 'utf8'), file.bytes.toString());
  assert.equal(fs.readFileSync(path.join(directory, 'result.txt'), 'utf8'), 'existing user file');
  assert.equal(path.dirname(result.path).startsWith(directory + path.sep + 'download-'), true);
  assert.equal(fs.existsSync(file.file), false); assert.equal(file.listenerCount('updated'), 0); assert.equal(file.listenerCount('done'), 0);
  capture.cancel(); assert.equal(fs.existsSync(result.path), true);
});
test('one capture cannot consume two items and filenames cannot escape its directory', async t => {
  const { directory, capture } = fixture(t), first = item(), second = item();
  assert.equal(capture.accept(first, { filename: '../CON\\unsafe?.txt' }), true);
  assert.equal(capture.accept(second, { filename: 'other.txt' }), false); assert.equal(second.file, undefined);
  first.finish(); const result = await capture.result;
  assert.equal(path.dirname(path.dirname(result.path)), directory);
  assert.doesNotMatch(result.filename, /[\\/?:]/); assert.equal(second.file, undefined);
});
test('completed native state does not pass when filesystem bytes disagree', async t => {
  const { directory, capture } = fixture(t), file = item();
  capture.accept(file, { filename: 'report.txt' }); file.received++; file.finish();
  await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_SIZE_MISMATCH' });
  assert.deepEqual(fs.readdirSync(directory), []);
});
test('known oversized downloads are cancelled before a save path is assigned', async t => {
  const { directory, capture } = fixture(t), file = item(); file.total = MAX_DOWNLOAD_BYTES + 1;
  assert.equal(capture.accept(file, { filename: 'huge.bin' }), false);
  await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_TOO_LARGE' });
  assert.equal(file.cancelled, true); assert.equal(file.file, undefined); assert.deepEqual(fs.readdirSync(directory), []);
});
test('unknown-length downloads are bounded as bytes arrive', async t => {
  const { directory, capture } = fixture(t, { maxBytes: 20 }), file = item(); file.total = 0;
  capture.accept(file, { filename: 'growing.bin' }); fs.writeFileSync(file.file, 'partial');
  file.received = 21; file.emit('updated', {}, 'progressing');
  await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_TOO_LARGE' });
  assert.equal(file.cancelled, true); assert.deepEqual(fs.readdirSync(directory), []);
});
test('interrupted native downloads never produce success or retain their partial files', async t => {
  const { directory, capture } = fixture(t), file = item(); capture.accept(file, { filename: 'broken.txt' }); file.finish('interrupted');
  await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_INTERRUPTED' }); assert.deepEqual(fs.readdirSync(directory), []);
});
test('abort cancels the native item and cleans only this operation partial files', async t => {
  const controller = new AbortController(), { capture } = fixture(t, { signal: controller.signal }), file = item();
  capture.accept(file, { filename: 'report.txt' }); fs.writeFileSync(file.file, 'partial');
  fs.writeFileSync(file.file + '.crdownload', 'chromium partial');
  const unrelated = path.join(path.dirname(file.file), 'keep.txt'); fs.writeFileSync(unrelated, 'user');
  controller.abort(); await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_CANCELLED' });
  assert.equal(file.cancelled, true); assert.equal(fs.existsSync(file.file), false); assert.equal(fs.existsSync(file.file + '.crdownload'), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'user');
});
test('TTL expiry releases an unused capture without touching pre-existing files', async t => {
  const { directory, capture } = fixture(t, { timeoutMs: 10 });
  fs.writeFileSync(path.join(directory, 'keep.txt'), 'user');
  await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_TIMEOUT' });
  assert.deepEqual(fs.readdirSync(directory), ['keep.txt']);
});
test('capture rechecks the task lease before accepting bytes', async t => {
  let allowed = true;
  const { directory, capture } = fixture(t, { check: () => { if (!allowed) throw Object.assign(new Error('接管'), { code: 'AUTOMATION_PAUSED' }); } });
  allowed = false; assert.equal(capture.accept(item(), { filename: 'refused.txt' }), false);
  await assert.rejects(capture.result, { code: 'AUTOMATION_PAUSED' }); assert.deepEqual(fs.readdirSync(directory), []);
});
test('final publication is exclusive and preserves an existing destination inside the fresh directory', async t => {
  const { capture } = fixture(t), file = item(); capture.accept(file, { filename: 'report.txt' });
  const existing = path.join(path.dirname(file.file), 'report.txt'); fs.writeFileSync(existing, 'user file created during transfer');
  file.finish(); await assert.rejects(capture.result, { code: 'BROWSER_DOWNLOAD_PUBLISH_FAILED' });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'user file created during transfer'); assert.equal(fs.existsSync(file.file), false);
});
test('invalid timeout, directory, and pre-aborted lease fail before arming', () => {
  assert.throws(() => createAutomationDownload({ directory: 'relative' }), { code: 'BROWSER_DOWNLOAD_DIRECTORY' });
  assert.throws(() => createAutomationDownload({ directory: os.tmpdir(), timeoutMs: 30001 }), { code: 'BROWSER_DOWNLOAD_TIMEOUT_INVALID' });
  const controller = new AbortController(); controller.abort();
  assert.throws(() => createAutomationDownload({ directory: os.tmpdir(), signal: controller.signal }), { code: 'BROWSER_DOWNLOAD_CANCELLED' });
});

test('an expectation cannot capture any download before the native click arm point', async t => {
  const { capture } = fixture(t, { arm: false }), early = item(), correct = item();
  assert.equal(capture.accept(early, { filename: 'driveby.txt' }), false);
  assert.equal(early.file, undefined); assert.equal(capture.consumed, false);
  capture.arm(); assert.equal(capture.accept(correct, { filename: 'clicked.txt' }), true); correct.finish();
  assert.equal((await capture.result).filename, 'clicked.txt');
});
