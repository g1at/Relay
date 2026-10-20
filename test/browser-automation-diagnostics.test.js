'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserDiagnostics } = require('../src/main/browser/browser-automation-diagnostics');

const text = value => ({ type: 'string', value });
function consoleMessage(collector, ...args) { return collector.handleMessage('Runtime.consoleAPICalled', { timestamp: Date.now(), type: 'log', args: args.map(text) }); }
function request(collector, id, url = 'https://example.test/api', extra = {}) {
  return collector.handleMessage('Network.requestWillBeSent', { requestId: id, type: 'Fetch',
    request: { url, method: 'GET', headers: { Authorization: 'forbidden-header' }, postData: 'forbidden-body' }, ...extra });
}

test('collects bounded primitive console arguments without object previews, descriptions or stacks', () => {
  const collector = createBrowserDiagnostics({ now: () => 123 });
  collector.handleMessage('Runtime.consoleAPICalled', { timestamp: 123, type: 'warning', stackTrace: { callFrames: [{ url: 'https://secret.test' }] }, args: [
    text('Saved'), { type: 'number', value: 42 }, { type: 'boolean', value: true }, { type: 'object', subtype: 'null', value: null },
    { type: 'undefined' }, { type: 'object', description: 'secret-object', objectId: 'secret-id', preview: { properties: [{ value: 'secret-preview' }] } },
    { type: 'function', description: 'secret-function' }, { type: 'number', unserializableValue: 'NaN' }, text('excess-argument'),
  ] });
  const result = collector.read(), event = result.events[0];
  assert.equal(result.cursor, 1); assert.equal(event.seq, 1); assert.equal(event.at, 123);
  assert.equal(event.kind, 'console'); assert.equal(event.level, 'warning'); assert.equal(event.omittedArguments, 1);
  assert.deepEqual(event.args.map(argument => argument.value), ['Saved', 42, true, null, 'undefined', '[omitted]', '[omitted]', 'NaN']);
  assert.doesNotMatch(JSON.stringify(result), /secret-object|secret-id|secret-preview|secret-function|secret\.test|excess-argument/);
  assert.ok(result.limitations.includes('console-secret-redaction-best-effort'));
});

test('console labels, tokens, URL credentials and opaque URL contents are omitted', () => {
  const collector = createBrowserDiagnostics();
  consoleMessage(collector, 'password=hunter123 token="secret-token" Authorization: Bearer secret-bearer',
    'https://alice:secret-pass@example.test/path?access_token=secret-query#secret-fragment',
    'api_key:', 'secret-next-argument', 'data:text/plain,secret-data',
    'sk-secretsecret123456789', 'eyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQiOjF9.signature');
  const output = JSON.stringify(collector.read());
  for (const secret of ['hunter123', 'secret-token', 'secret-bearer', 'alice', 'secret-pass', 'secret-query', 'secret-fragment',
    'secret-next-argument', 'secret-data', 'sk-secretsecret', 'eyJhbG']) assert.equal(output.includes(secret), false, secret);
  assert.ok(output.includes('https://example.test/path'));
  consoleMessage(collector, 'token=%s', 'secret-format-argument');
  assert.doesNotMatch(JSON.stringify(collector.read()), /secret-format-argument/);
  consoleMessage(collector, 'x'.repeat(9000));
  assert.match(collector.read().events.at(-1).args[0].value, /overlong string omitted/);
});

test('exceptions keep a redacted first error line and safe source coordinates only', () => {
  const collector = createBrowserDiagnostics();
  collector.handleMessage('Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: { text: 'Uncaught',
    exception: { subtype: 'error', description: 'Error: password=bad-secret\n at secret-stack-function (https://host/secret)' },
    url: 'https://user:password@example.test/main.js?token=hidden#source', lineNumber: 4, columnNumber: 8,
    stackTrace: { callFrames: [{ functionName: 'secret-stack-function' }] } } });
  const event = collector.read().events[0];
  assert.equal(event.type, 'exception'); assert.equal(event.level, 'error');
  assert.equal(event.line, 5); assert.equal(event.column, 9); assert.equal(event.url, 'https://example.test/main.js');
  assert.doesNotMatch(JSON.stringify(event), /bad-secret|secret-stack-function|hidden|#source/);
  collector.handleMessage('Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: { text: 'Uncaught object', exception: { type: 'object', description: 'sensitive arbitrary object' } } });
  assert.equal(collector.read().events[1].message, 'Uncaught object');
});

test('network records omit headers, request bodies, response bodies, query, credentials, fragments and initiators', () => {
  const collector = createBrowserDiagnostics();
  request(collector, '12.1', 'https://user:secret-password@example.test/api?token=secret-query#secret-fragment', {
    initiator: { stack: { description: 'secret-initiator' } }, documentURL: 'https://secret-document.test' });
  collector.handleMessage('Network.responseReceived', { requestId: '12.1', response: {
    url: 'https://user:secret-password@example.test/api?session=secret-query', status: 200,
    headers: { 'Set-Cookie': 'secret-cookie' }, mimeType: 'application/json', protocol: 'h2',
    body: 'secret-response-body', fromDiskCache: true, fromServiceWorker: false } });
  collector.handleMessage('Network.loadingFinished', { requestId: '12.1', encodedDataLength: 1234 });
  const result = collector.read(), output = JSON.stringify(result);
  assert.deepEqual(result.events.map(event => event.type), ['request', 'response', 'finished']);
  assert.equal(result.events[0].url, 'https://example.test/api');
  assert.equal(result.events[1].fromDiskCache, true); assert.equal(result.events[2].encodedDataLength, 1234);
  for (const secret of ['forbidden-header', 'forbidden-body', 'secret-password', 'secret-query', 'secret-fragment', 'secret-cookie',
    'secret-response-body', 'secret-initiator', 'secret-document']) assert.equal(output.includes(secret), false, secret);
});

test('redirect hops and ordinary requestId reuse remain distinguishable', () => {
  const collector = createBrowserDiagnostics();
  request(collector, 'same', 'https://example.test/start');
  request(collector, 'same', 'https://example.test/end?code=hidden', {
    redirectResponse: { url: 'https://example.test/start?token=hidden', status: 302 } });
  collector.handleMessage('Network.responseReceived', { requestId: 'same', response: { url: 'https://example.test/end', status: 200 } });
  collector.handleMessage('Network.loadingFinished', { requestId: 'same', encodedDataLength: 1 });
  request(collector, 'same', 'https://example.test/new');
  const events = collector.read().events;
  assert.deepEqual(events.map(event => [event.type, event.hop]), [['request', 0], ['redirect', 0], ['request', 1], ['response', 1], ['finished', 1], ['request', 2]]);
  assert.equal(events[1].to, 'https://example.test/end'); assert.equal(events[1].status, 302);
  assert.equal(events[2].redirected, true); assert.equal(events[2].requestIdReused, false);
  assert.equal(events[5].requestIdReused, true);
  assert.equal(events[5].redirected, false);
});

test('HTTP error responses are separate from transport failures and canceled requests', () => {
  const collector = createBrowserDiagnostics();
  request(collector, 'http');
  collector.handleMessage('Network.responseReceived', { requestId: 'http', response: { status: 503, url: 'https://example.test/unavailable' } });
  collector.handleMessage('Network.loadingFinished', { requestId: 'http', encodedDataLength: 33 });
  request(collector, 'transport');
  collector.handleMessage('Network.loadingFailed', { requestId: 'transport', errorText: 'net::ERR_CONNECTION_REFUSED', canceled: false,
    corsErrorStatus: { corsError: 'InvalidAllowCredentials', failedParameter: 'secret-cors-parameter' } });
  const events = collector.read().events, response = events.find(event => event.type === 'response'), failed = events.find(event => event.type === 'failed');
  assert.equal(response.status, 503); assert.equal(response.httpError, true); assert.equal(response.transportFailure, undefined);
  assert.equal(failed.transportFailure, true); assert.equal(failed.error, 'net::ERR_CONNECTION_REFUSED'); assert.equal(failed.canceled, false);
  assert.equal(events.find(event => event.type === 'finished').transportFailure, false);
  assert.doesNotMatch(JSON.stringify(events), /secret-cors-parameter/);
});

test('ring buffer reports lost events and paginates with a monotonic cursor', () => {
  const collector = createBrowserDiagnostics({ maxEvents: 3 });
  for (let i = 0; i < 5; i++) consoleMessage(collector, 'message ' + i);
  const first = collector.read({ limit: 2 });
  assert.deepEqual(first.events.map(event => event.seq), [3, 4]);
  assert.equal(first.dropped, 2); assert.equal(first.cursor, 4); assert.equal(first.hasMore, true);
  const second = collector.read({ since: first.cursor, collectionId: first.collectionId, limit: 2 });
  assert.deepEqual(second.events.map(event => event.seq), [5]);
  assert.equal(second.dropped, 0); assert.equal(second.cursor, 5); assert.equal(second.hasMore, false);
  assert.deepEqual(collector.read({ since: 5, collectionId: first.collectionId }).events, []);
});

test('filtered reads advance over other kinds without losing a remaining requested-kind page', () => {
  const collector = createBrowserDiagnostics();
  consoleMessage(collector, 'first'); request(collector, 'one'); consoleMessage(collector, 'second'); request(collector, 'two');
  const first = collector.read({ kind: 'console', limit: 1 });
  assert.equal(first.cursor, 1); assert.equal(first.hasMore, true);
  const second = collector.read({ kind: 'console', since: first.cursor, collectionId: first.collectionId, limit: 1 });
  assert.equal(second.events[0].seq, 3); assert.equal(second.cursor, 4); assert.equal(second.hasMore, false);
  assert.deepEqual(collector.read({ kind: 'network', since: 4, collectionId: first.collectionId }).events, []);
  assert.equal(collector.read({ kind: 'network' }).events.length, 2);
});

test('returned data cannot mutate retained events and clear cannot rewind a previously issued cursor', () => {
  const collector = createBrowserDiagnostics(); consoleMessage(collector, 'original');
  const result = collector.read(); result.events[0].args[0].value = 'forged'; result.limitations.length = 0;
  assert.equal(collector.read().events[0].args[0].value, 'original'); assert.ok(collector.read().limitations.length > 0);
  collector.clear();
  assert.equal(collector.read().cursor, 1); assert.equal(collector.read().dropped, 1); assert.deepEqual(collector.read().events, []);
  consoleMessage(collector, 'after clear');
  assert.equal(collector.read({ since: 1, collectionId: collector.read().collectionId }).events[0].seq, 2);
});

test('request correlation is bounded and late or partial records explicitly mark unknown requests', () => {
  const collector = createBrowserDiagnostics({ maxRequests: 1 });
  request(collector, 'old'); request(collector, 'new');
  collector.handleMessage('Network.loadingFailed', { requestId: 'old', errorText: 'net::ERR_ABORTED' });
  collector.handleMessage('Network.responseReceived', { requestId: 'partial', response: { status: 404, url: 'https://example.test/late' } });
  const events = collector.read().events;
  assert.equal(events[2].requestKnown, false); assert.equal(events[2].hop, null); assert.equal(events[2].url, undefined);
  assert.equal(events[3].requestKnown, false); assert.equal(events[3].status, 404);
});

test('unrecognized protocol payloads and malformed events are ignored without retaining raw data', () => {
  const collector = createBrowserDiagnostics();
  for (const method of ['Network.requestWillBeSentExtraInfo', 'Network.responseReceivedExtraInfo', 'Network.webSocketFrameReceived', 'Runtime.bindingCalled']) {
    assert.equal(collector.handleMessage(method, { headers: { Secret: 'forbidden' }, body: 'forbidden', payloadData: 'forbidden' }), false);
  }
  for (const params of [null, [], false]) assert.equal(collector.handleMessage('Network.requestWillBeSent', params), false);
  assert.equal(collector.handleMessage('Network.requestWillBeSent', {}), false);
  assert.equal(collector.handleMessage('Network.requestWillBeSent', { requestId: 'id', request: {} }), false);
  assert.equal(collector.handleMessage('Runtime.exceptionThrown', {}), false);
  assert.deepEqual(collector.read().events, []);
});

test('opaque and malformed network URLs never expose embedded content or filesystem paths', () => {
  const collector = createBrowserDiagnostics();
  for (const [id, url] of ['data:text/plain,secret-data', 'blob:https://example.test/secret-blob', 'file:///C:/Users/secret-file', 'malformed-secret-url'].entries()) request(collector, String(id), url);
  const output = JSON.stringify(collector.read());
  assert.doesNotMatch(output, /secret-data|secret-blob|secret-file|malformed-secret-url/);
  assert.match(output, /data:\[redacted\]/);
});

test('invalid read options fail explicitly and disposal clears the collector permanently', () => {
  for (const maxEvents of [0, -1, 1001, 1.5, NaN]) assert.throws(() => createBrowserDiagnostics({ maxEvents }), RangeError);
  assert.throws(() => createBrowserDiagnostics({ now: 5 }), TypeError);
  const collector = createBrowserDiagnostics(); consoleMessage(collector, 'private old task');
  for (const since of [-1, 1.5, 2, NaN, '0']) assert.throws(() => collector.read({ since, collectionId: collector.read().collectionId }), { code: 'BROWSER_DIAGNOSTICS_INVALID_CURSOR' });
  for (const limit of [0, 201, -1, NaN, '1']) assert.throws(() => collector.read({ limit }), { code: 'BROWSER_DIAGNOSTICS_INVALID_LIMIT' });
  assert.throws(() => collector.read({ kind: 'headers' }), { code: 'BROWSER_DIAGNOSTICS_INVALID_KIND' });
  collector.dispose(); collector.dispose(); collector.clear();
  assert.equal(consoleMessage(collector, 'after disposal'), false);
  assert.throws(() => collector.read(), { code: 'BROWSER_DIAGNOSTICS_DISPOSED' });
});


test('cached Runtime events from before the current lease or clear are never replayed', () => {
  let clock = 1000;
  const collector = createBrowserDiagnostics({ now: () => clock });
  const message = timestamp => collector.handleMessage('Runtime.consoleAPICalled', { timestamp, type: 'log', args: [text('fixture')] });
  assert.equal(message(999), false); assert.equal(message(undefined), false); assert.equal(message(NaN), false);
  assert.equal(collector.handleMessage('Runtime.exceptionThrown', { timestamp: 999, exceptionDetails: { text: 'old exception' } }), false);
  assert.equal(message(1000), true); assert.equal(collector.read().events.length, 1);
  clock = 2000; collector.clear();
  assert.equal(message(1500), false); assert.equal(message(2000), true);
  assert.equal(collector.read().events.length, 1); assert.equal(collector.read().events[0].seq, 2);
});


test('numeric cursors cannot cross collector lifetimes or clear boundaries even when sequence numbers overlap', () => {
  const old = createBrowserDiagnostics(); consoleMessage(old, 'old record');
  const prior = old.read();
  const next = createBrowserDiagnostics(); consoleMessage(next, 'new first'); consoleMessage(next, 'new second');
  assert.notEqual(prior.collectionId, next.read().collectionId);
  for (const collectionId of [undefined, prior.collectionId, 'forged']) {
    assert.throws(() => next.read({ since: prior.cursor, collectionId }), { code: 'BROWSER_DIAGNOSTICS_STALE_COLLECTION' });
  }
  assert.throws(() => next.read({ since: 0, collectionId: prior.collectionId }), { code: 'BROWSER_DIAGNOSTICS_STALE_COLLECTION' });
  const current = next.read();
  assert.deepEqual(next.read({ since: 1, collectionId: current.collectionId }).events.map(event => event.seq), [2]);
  next.clear(); consoleMessage(next, 'post clear');
  assert.notEqual(next.read().collectionId, current.collectionId);
  assert.throws(() => next.read({ since: current.cursor, collectionId: current.collectionId }), { code: 'BROWSER_DIAGNOSTICS_STALE_COLLECTION' });
  assert.equal(next.read({ since: 0 }).events[0].args[0].value, 'post clear');
});
