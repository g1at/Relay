'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { dispatchLiveInput } = require('../live-mcp-dispatch');
const { submitLiveSupplement, normalizeSupplement } = require('../live-supplement-input');
const { LiveTurnRouter } = require('../live-turn-router');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const JOB = '11111111-1111-4111-8111-111111111111';
const FOLLOW = '22222222-2222-4222-8222-222222222222';

function fixture(t, { prepareContent } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-images-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const imagePath = path.join(directory, 'fixture.png'); fs.writeFileSync(imagePath, PNG);
  const inputs = [], events = [], results = [];
  let count = 0;
  const fakeSdk = { query({ prompt }) {
    count++;
    return { initializationResult: async () => ({}), close() {},
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt) {
          inputs.push(message);
          yield { ...message, type: 'user' }; // SDK replay-user-messages echo
          yield { type: 'result', subtype: 'success', is_error: false, result: 'fixture complete', user_message_uuid: message.uuid };
        }
      },
    };
  } };
  const sdkPath = path.join(__dirname, '..', 'claude-sdk.js');
  const source = fs.readFileSync(sdkPath, 'utf8').replace('let sdkPromise = null;', 'let sdkPromise = Promise.resolve(globalThis.fixtureSdk);');
  const context = vm.createContext({ fixtureSdk: fakeSdk, process, AbortController, console: { warn() {}, error() {} }, setTimeout, clearTimeout });
  const factory = new vm.Script(`(function(require,module,exports,__dirname) {\n${source}\n})`, { filename: sdkPath }).runInContext(context);
  const localRequire = createRequire(sdkPath);
  const loaded = { exports: {} }; factory(name => name === './attachment-input' && prepareContent
    ? { ...localRequire(name), prepareAttachmentContent: prepareContent } : localRequire(name), loaded, loaded.exports, path.dirname(sdkPath));
  const emit = event => { events.push(event); if (event.type === 'result') { const resolve = results.shift(); if (resolve) resolve(); } };
  return { sdk: loaded.exports, inputs, events, emit, imagePath, count: () => count,
    nextResult: () => new Promise(resolve => results.push(resolve)) };
}

function assertImage(input) {
  const images = input.message.content.filter(block => block.type === 'image');
  assert.equal(images.length, 1);
  assert.deepEqual(Buffer.from(images[0].source.data, 'base64'), PNG);
  assert.equal(Object.hasOwn(input, 'files'), false, 'host metadata is never an SDK wire field');
}

test('one-shot sends host PNG image blocks with the same UUID and strips replay bytes from emitted events', async t => {
  const f = fixture(t);
  const { handle } = f.sdk.runOneShot({ prompt: '查看截图', files: [{ path: f.imagePath }], userMessageId: JOB,
    runtimeEnv: { RELAY_AGENT_ENVIRONMENT: 'wsl' }, onEvent: f.emit });
  await handle.whenClosed();
  assert.equal(f.inputs.length, 1); assert.equal(f.inputs[0].uuid, JOB); assertImage(f.inputs[0]);
  assert.equal(JSON.stringify(f.events).includes(PNG.toString('base64')), false);
  assert.equal(f.events.at(-1).type, 'job-done');
  assert.equal(f.events.at(-1).exitCode, 0);
});

test('live dispatch, resumed turns and queued supplement all preserve image bytes and priorities in one Query', async t => {
  const f = fixture(t), files = [{ path: f.imagePath }, { path: 'D:\\fixture space\\notes.txt' }];
  const child = f.sdk.createLiveSession({ sessionId: 'fixture-existing-session',
    runtimeEnv: { RELAY_AGENT_ENVIRONMENT: 'wsl' }, onMessage: f.emit, onExit() {} });
  t.after(() => child.kill());
  // Isolate only readiness transport; use real Relay dispatch and image adapter.
  child.prepareMcp = async () => ({ ok: true, items: [] });
  const session = { child, jobId: JOB, busy: true, dead: false, turnRouter: new LiveTurnRouter() };
  session.turnRouter.begin(JOB);
  const first = f.nextResult();
  dispatchLiveInput({ session, jobId: JOB, prompt: '第一轮', files, loadServers: () => ({}), isSessionCurrent: () => true,
    onStatus() {}, onFailure: error => assert.fail(error) });
  await first;
  const second = f.nextResult();
  child.push('继续查看', { uuid: 'resumed-fixture', files }); await second;
  const third = f.nextResult();
  assert.equal(submitLiveSupplement({ session, jobId: JOB,
    input: normalizeSupplement({ messageId: FOLLOW, prompt: '补图', files, followUpMode: 'queue' }), persist() {}, emit() {},
  }).ok, true);
  await third;
  assert.equal(f.count(), 1);
  assert.equal(f.inputs.length, 3);
  for (const input of f.inputs) {
    assertImage(input);
    assert.match(input.message.content[0].text, /\/mnt\/d\/fixture space\/notes.txt/);
    assert.equal(input.message.content[0].text.includes('D:\\fixture space'), false);
  }
  assert.equal(f.inputs[2].uuid, FOLLOW); assert.equal(f.inputs[2].priority, 'later');
  assert.equal(JSON.stringify(f.events).includes(PNG.toString('base64')), false);
  await child.kill();
});

for (const kind of ['live', 'one-shot']) test(`${kind} cancellation during host image reading cannot enqueue a late SDK message`, async t => {
  let markReading, finishReading;
  const reading = new Promise(resolve => { markReading = resolve; });
  const gate = new Promise(resolve => { finishReading = resolve; });
  const actual = require('../attachment-input').prepareAttachmentContent;
  const f = fixture(t, { prepareContent: async (...args) => { markReading(); await gate; return actual(...args); } });
  const params = { prompt: '检查截图', files: [{ path: f.imagePath }], onEvent: f.emit, onMessage: f.emit, onExit() {} };
  const handle = kind === 'live' ? f.sdk.createLiveSession(params) : f.sdk.runOneShot(params).handle;
  if (kind === 'live') handle.push(params.prompt, { uuid: JOB, files: params.files });
  await reading;
  const closed = handle.kill();
  finishReading(); await closed;
  assert.equal(f.inputs.length, 0);
  assert.equal(JSON.stringify(f.events).includes(PNG.toString('base64')), false);
});
