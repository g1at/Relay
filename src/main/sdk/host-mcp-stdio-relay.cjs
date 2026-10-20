'use strict';
// Query-owned Windows stdio facade for WSL. Only loopback HTTP, no tool execution
// or POST retry. The executable runs in Windows so WSL NAT is irrelevant.
const http = require('node:http');
const readline = require('node:readline');
let endpoint;
try { endpoint = new URL(process.argv[2]); } catch (_) { process.exit(1); }
const authorization = process.env.RELAY_MCP_LOOPBACK_AUTH;
delete process.env.RELAY_MCP_LOOPBACK_AUTH;
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !/^Bearer [a-f0-9]{64}$/.test(authorization || '')) process.exit(1);
let session, version, stopping = false, eventStream, reconnects = 0, reconnectTimer;
const pending = new Set();
const write = message => { if (!stopping) process.stdout.write(JSON.stringify(message) + '\n'); };
const failed = message => { if (message?.id !== undefined && message.method) write({ jsonrpc: '2.0', id: message.id,
  error: { code: -32000, message: 'Relay MCP transport unavailable.' } }); };
function headers() {
  return { Authorization: authorization, Accept: 'application/json, text/event-stream',
    ...(session ? { 'Mcp-Session-Id': session } : {}), ...(version ? { 'MCP-Protocol-Version': version } : {}) };
}
function consume(response, deliver) {
  let data = '', event = [], bytes = 0;
  const sse = String(response.headers['content-type']).includes('text/event-stream');
  response.setEncoding('utf8');
  response.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 32 * 1024 * 1024) { response.destroy(); return; }
    data += chunk;
    if (!sse) return;
    let end;
    while ((end = data.indexOf('\n')) >= 0) {
      const line = data.slice(0, end).replace(/\r$/, ''); data = data.slice(end + 1);
      if (!line) {
        if (event.length) { try { deliver(JSON.parse(event.join('\n'))); } catch (_) {} event = []; }
        bytes = Buffer.byteLength(data);
      } else if (line.startsWith('data:')) event.push(line.slice(5).trimStart());
    }
  });
  response.on('end', () => { if (!sse && data) try { deliver(JSON.parse(data)); } catch (_) {} });
}
function retryEvents(request) {
  if (stopping || eventStream !== request || reconnectTimer) return;
  if (++reconnects > 3) { void close(); return; }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    events().then(() => { reconnects = 0; }).catch(() => retryEvents(eventStream));
  }, 100);
}
function events() {
  return new Promise((resolve, reject) => {
    if (stopping || !session) { resolve(); return; }
    const request = http.get(endpoint, { headers: headers() }); eventStream = request;
    const timeout = setTimeout(() => request.destroy(Error('MCP_EVENTS_TIMEOUT')), 10000);
    const reconnect = () => retryEvents(request);
    request.once('response', response => {
      clearTimeout(timeout);
      if (response.statusCode !== 200) { response.resume(); reject(Error('MCP_EVENTS_UNAVAILABLE')); return; }
      consume(response, write); resolve();
      // The stream is intentionally idle between task events. Timeout only
      // connection/headers; an idle socket must not lose later tool updates.
      response.once('close', reconnect);
      response.once('error', reconnect);
    });
    request.once('error', cause => { clearTimeout(timeout); reject(cause); });
  });
}
function send(message) {
  if (stopping) return;
  const request = http.request(endpoint, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' } });
  pending.add(request);
  request.once('close', () => pending.delete(request));
  request.once('error', () => failed(message));
  request.once('response', response => {
    if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); failed(message); return; }
    if (response.headers['mcp-session-id']) session = response.headers['mcp-session-id'];
    consume(response, async result => {
      if (message.method === 'initialize' && result.result) {
        version = result.result.protocolVersion;
        try { await events(); } catch (_) { failed(message); return; }
      }
      write(result);
    });
  });
  request.end(JSON.stringify(message));
}
async function close() {
  if (stopping) return;
  stopping = true; clearTimeout(reconnectTimer);
  eventStream?.destroy(); for (const request of pending) request.destroy(); pending.clear();
  if (session) await new Promise(resolve => {
    const request = http.request(endpoint, { method: 'DELETE', headers: headers() }, response => { response.resume(); response.on('end', resolve); });
    request.on('error', resolve); request.setTimeout(500, () => { request.destroy(); resolve(); }); request.end();
  });
  process.exit(0);
}
process.stdout.on('error', () => { void close(); });
process.stdin.on('error', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (Buffer.byteLength(line) > 8 * 1024 * 1024) { void close(); return; }
  try { const message = JSON.parse(line); if (message && typeof message === 'object' && !Array.isArray(message)) send(message); } catch (_) { void close(); }
}).on('close', () => { void close(); });
