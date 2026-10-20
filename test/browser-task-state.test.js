'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserTaskState } = require('../src/main/browser/browser-task-state');

test('task recovery round-trips only URLs, titles and association, never authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-task-browser-'));
  try {
    const filePath = path.join(root, 'task-tabs.json');
    const store = createBrowserTaskState({ filePath, now: () => 17 });
    store.upsert({ id: 'page-a', conversationId: 'task-a', url: 'https://example.test/a', title: 'A',
      state: 'controlled', observationId: 'stale', refs: ['e1'], permissions: { upload: true }, cookies: ['secret'] });
    store.upsert({ id: 'page-b', conversationId: 'task-b', url: 'http://localhost:3000/b', title: 'B' });
    const saved = JSON.parse(fs.readFileSync(filePath));
    assert.deepEqual(Object.keys(saved.tabs[0]).sort(), ['conversationId', 'id', 'title', 'updatedAt', 'url']);
    const reopened = createBrowserTaskState({ filePath });
    assert.deepEqual(reopened.list('task-a'), [{ id: 'page-a', conversationId: 'task-a', url: 'https://example.test/a', title: 'A', updatedAt: 17 }]);
    const copy = reopened.list('task-a'); copy[0].url = 'https://other.test/';
    assert.equal(reopened.list('task-a')[0].url, 'https://example.test/a');
    reopened.remove('page-a'); assert.deepEqual(reopened.list('task-a'), []);
    assert.equal(createBrowserTaskState({ filePath }).list('task-b').length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recovery rejects privileged URLs, embedded credentials and malformed task identities', () => {
  const store = createBrowserTaskState();
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hello', 'about:blank', 'https://user:secret@example.test/', 'https://example.test/\n']) {
    assert.throws(() => store.upsert({ id: 'x', conversationId: 'task', url }), { code: 'INVALID_URL' });
  }
  for (const conversationId of ['', 'x\ny', null, {}, 'x'.repeat(201)]) {
    assert.throws(() => store.list(conversationId), { code: 'INVALID_CONVERSATION' });
  }
  assert.deepEqual(store.list('task'), []);
});

test('malformed recovery state is preserved without destructive repair', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-task-browser-invalid-'));
  try {
    const filePath = path.join(root, 'task-tabs.json');
    for (const content of ['not-json', JSON.stringify({ version: 2, tabs: [] }), JSON.stringify({ version: 1, tabs: [{ id: 'x', conversationId: 'a', url: 'file:///secret' }] })]) {
      fs.writeFileSync(filePath, content);
      assert.throws(() => createBrowserTaskState({ filePath }), { code: 'BROWSER_TASK_STATE_INVALID' });
      assert.equal(fs.readFileSync(filePath, 'utf8'), content);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed persistence write does not mutate the in-memory recovery index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-task-browser-write-'));
  try {
    const filePath = path.join(root, 'task-tabs.json'), store = createBrowserTaskState({ filePath });
    store.upsert({ id: 'x', conversationId: 'a', url: 'https://example.test/' });
    fs.unlinkSync(filePath); fs.mkdirSync(filePath);
    assert.throws(() => store.upsert({ id: 'x', conversationId: 'a', url: 'https://other.test/' }), { code: 'BROWSER_TASK_STATE_WRITE_FAILED' });
    assert.equal(store.list('a')[0].url, 'https://example.test/');
    assert.deepEqual(fs.readdirSync(root), ['task-tabs.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
