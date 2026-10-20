'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

test('packaged stdio facade survives 31 seconds of idle SSE, retries failed reconnects, and never retries business POSTs', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay facade 文件 '));
  const script = path.join(root, 'resources/app.asar.unpacked/src/main/sdk/host-mcp-stdio-relay.cjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../src/main/sdk/host-mcp-stdio-relay.cjs'), script);
  assert.ok(require('../package.json').build.asarUnpack.includes('src/main/sdk/host-mcp-stdio-relay.cjs'));
  const auth = 'Bearer ' + randomBytes(32).toString('hex'), received = [], messages = [];
  let events, gets = 0, rejectGets = 0, deletes = 0, child;
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, auth);
    if (request.method === 'GET') {
      gets++;
      if (rejectGets > 0) { rejectGets--; response.writeHead(503); response.end(); return; }
      events = response;
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
      return;
    }
    if (request.method === 'DELETE') { deletes++; response.writeHead(200); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw); received.push(message);
    if (message.method === 'tools/call') { response.destroy(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } : {};
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  t.after(async () => {
    child?.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, [script, 'http://127.0.0.1:' + server.address().port + '/mcp'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RELAY_MCP_LOOPBACK_AUTH: auth }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  require('node:readline').createInterface({ input: child.stdout }).on('line', line => messages.push(JSON.parse(line)));
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  async function until(predicate, label) {
    const deadline = Date.now() + 4000;
    while (!predicate()) { if (Date.now() > deadline) assert.fail(label + ': ' + stderr); await delay(10); }
  }
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  await until(() => messages.some(message => message.id === 1), 'initialized');
  assert.equal(gets, 1);
  await delay(31000);
  events.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n\n');
  await until(() => messages.some(message => message.method === 'notifications/tools/list_changed'), 'notification after idle');
  assert.equal(gets, 1, 'idle stream was not destroyed or reconnected');
  rejectGets = 2; events.destroy();
  await until(() => gets === 4 && rejectGets === 0, 'two failed reconnects followed by recovery');
  events.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' }) + '\n\n');
  await until(() => messages.some(message => message.method === 'notifications/resources/list_changed'), 'notification after reconnect');
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_once', arguments: { text: 'unchanged' } } };
  child.stdin.write(JSON.stringify(call) + '\n');
  await until(() => messages.some(message => message.id === 2 && message.error), 'failed business call');
  assert.deepEqual(received.filter(message => message.method === 'tools/call'), [call]);
  child.stdin.end();
  assert.equal(await exited, 0); assert.equal(deletes, 1); assert.equal(stderr, '');
});
