'use strict';

const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const owners = new WeakMap();
const error = code => Object.assign(new Error(code), { code });

// Process-transport registrations override same-named user entries in the CLI;
// SDK registrations do not. Keep the original host bridge and permissions, but
// expose it through an authenticated, query-owned loopback transport.
async function exposeHostMcpLoopback(name, sdkConfig, { signal, catalogTimeoutMs = 5000 } = {}) {
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const instance = sdkConfig.instance;
  const bearer = Buffer.from('Bearer ' + randomBytes(32).toString('hex'));
  const route = '/mcp/' + randomUUID();
  let entry, transition = Promise.resolve(), closing, closed = false, readStatus;
  const canceled = new AbortController();
  let config, registration;
  const matchesStatus = item => item?.name === name && item.source === 'dynamic'
    && (registration?.type === 'stdio'
      ? (item.config?.type === 'stdio' || item.config?.type == null) && item.config?.command === registration.command
        && JSON.stringify(item.config?.args || []) === JSON.stringify(registration.args || [])
      : item.config?.type === 'http' && item.config.url === config?.url);
  const visible = async (names, current) => {
    if (!names.length) return;
    if (typeof readStatus !== 'function') throw error('MCP_CATALOG_STATUS_UNAVAILABLE');
    const deadline = Date.now() + catalogTimeoutMs;
    while (!closed && entry === current && !current.closed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer, onCancel;
      const statuses = await Promise.race([
        Promise.resolve().then(readStatus),
        new Promise((_, reject) => { timer = setTimeout(() => reject(error('MCP_CATALOG_STATUS_TIMEOUT')), remaining); timer.unref?.(); }),
        new Promise((_, reject) => {
          onCancel = () => reject(error('MCP_LOOPBACK_CLOSED'));
          if (canceled.signal.aborted) onCancel();
          else canceled.signal.addEventListener('abort', onCancel, { once: true });
        }),
      ]).finally(() => { clearTimeout(timer); canceled.signal.removeEventListener('abort', onCancel); });
      const status = Array.isArray(statuses) && statuses.find(matchesStatus);
      if (status?.status === 'connected' && names.every(tool => status.tools?.some(item => item.name === tool))) return;
      await delay(Math.min(20, Math.max(1, deadline - Date.now())), undefined, { signal: canceled.signal });
    }
    throw error(closed ? 'MCP_LOOPBACK_CLOSED' : 'MCP_CATALOG_NOT_VISIBLE');
  };
  async function newEntry() {
    if (closed) throw error('MCP_LOOPBACK_CLOSED');
    if (entry) { entry.closed = true; await instance.close(); await entry.transport.close(); }
    const current = { closed: false, discovery: new Set(), transport: null, endpoint: null };
    const transport = current.transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const endpoint = current.endpoint = {
      start: () => transport.start(),
      close: () => transport.close(),
      async send(message) {
        if (message.id !== undefined && !message.method && current.discovery.has(message.id)) {
          current.discovery.delete(message.id);
          if (message.result && !message.result.isError) {
            let names = [];
            try { names = JSON.parse(message.result.content?.[0]?.text).activated || []; } catch (_) {}
            if (Array.isArray(names) && names.length) {
              try { await visible(names, current); }
              catch (_) { message = { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text',
                text: 'The client has not confirmed the discovered tools. No business operation ran. Retry discovery before calling an original tool.' }] } }; }
            }
          }
        }
        return transport.send(message);
      },
    };
    transport.onmessage = (message, extra) => {
      if (current.closed || entry !== current) return;
      if (message.method === 'tools/call' && instance.toolCatalog.isDiscoveryTool(message.params?.name)) current.discovery.add(message.id);
      endpoint.onmessage?.(message, extra);
    };
    // HTTP parsing/protocol errors are request-local. In particular, the CLI's
    // optimistic session probe may receive 400 before its valid initialize.
    transport.onerror = () => {};
    transport.onclose = () => {
      current.closed = true;
      if (entry === current) endpoint.onclose?.();
    };
    entry = current;
    await instance.connect(endpoint);
    return current;
  }
  const respond = (response, status) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end('{}'); };
  const server = http.createServer(async (request, response) => {
    try {
      if (closed) return respond(response, 503);
      const authorization = Buffer.from(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
      if (authorization.length !== bearer.length || !timingSafeEqual(authorization, bearer)) return respond(response, 401);
      if (request.headers.host !== '127.0.0.1:' + server.address().port || request.headers.origin || request.url !== route) return respond(response, 403);
      if (!['GET', 'POST', 'DELETE'].includes(request.method)) return respond(response, 405);
      let body;
      if (request.method === 'POST') {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) return respond(response, 413);
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return respond(response, 400); }
      }
      const initialize = body?.method === 'initialize' && !request.headers['mcp-session-id'];
      const work = transition.then(async () => {
        if (!entry || entry.closed || (initialize && entry.transport.sessionId)) return newEntry();
        return entry;
      });
      transition = work.catch(() => {});
      const current = await work;
      if (closed || current !== entry || current.closed) return respond(response, 503);
      await current.transport.handleRequest(request, response, body);
    } catch (_) { if (!response.headersSent) respond(response, 500); else response.end(); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.unref();
  const owner = {
    instance,
    matchesStatus,
    registerAlias(alias) { registration = alias; owners.set(alias, owner); return alias; },
    setStatusReader(reader) { readStatus = reader; },
    close() {
      if (closing) return closing;
      closed = true; canceled.abort(); signal?.removeEventListener('abort', onAbort);
      closing = (async () => {
        await transition;
        await instance.close();
        if (entry) { entry.closed = true; await entry.transport.close(); }
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      })();
      const operation = closing;
      operation.catch(() => { if (closing === operation) closing = null; });
      return operation;
    },
  };
  const onAbort = () => { void owner.close().catch(() => {}); };
  try {
    if (signal?.aborted) throw error('MCP_LOOPBACK_CLOSED');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    server.unref();
    config = { type: 'http', url: 'http://127.0.0.1:' + server.address().port + route,
      headers: { Authorization: bearer.toString() },
      ...(sdkConfig.timeout !== undefined ? { timeout: sdkConfig.timeout } : {}),
      ...(instance.config.alwaysLoad !== undefined ? { alwaysLoad: instance.config.alwaysLoad } : {}),
    };
    registration = config;
    owners.set(config, owner);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { await owner.close(); throw error('MCP_LOOPBACK_CLOSED'); }
    return config;
  } catch (cause) { await owner.close(); throw cause; }
}

module.exports = { exposeHostMcpLoopback, getHostMcpLoopbackOwner: config => config && owners.get(config) };
