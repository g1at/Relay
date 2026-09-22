'use strict';

const { randomUUID } = require('node:crypto');

const hasId = message => message && message.id !== undefined && message.id !== null;
const isRequest = message => hasId(message) && typeof message.method === 'string';
let HostServerClass;
const isHostServer = instance => !!HostServerClass && instance instanceof HostServerClass;

// Most launches only need routing helpers. Loading McpServer here also loads
// its schema validators; wait until a Windows stdio bridge is actually needed.
// Cache the real SDK subclass so existing instances keep their identity during
// runtime replacement, ownership checks and shutdown.
function getHostServerClass() {
  if (HostServerClass) return HostServerClass;
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

  // The agent SDK supplies a bidirectional Transport for an in-process McpServer.
  // This server relays that transport to a Windows-hosted stdio MCP verbatim. Its
  // initialize response, capabilities, schemas, notifications and errors belong
  // to the original server; Relay neither rebuilds a tool list nor replays calls.
  return HostServerClass = class HostStdioMcpServer extends McpServer {
    constructor(name, config, options = {}) {
      super({ name, version: '1.0.0' });
      this.name = name;
      this.config = config;
      this.options = options;
      this.endpoint = null;
      this.childTransport = null;
      this.starting = null;
      this.pending = new Map();
      this.settled = new Set();
      this.reverseRequests = new Map();
      this.failure = null;
      this.closed = true;
      this.closePromise = null;
      this.stopping = new Set();
    }

    async connect(endpoint) {
      if (this.endpoint && !this.closed) throw new Error('MCP host bridge is already connected');
      if (this.closePromise) await this.closePromise;
      this.closePromise = null;
      this.endpoint = endpoint;
      this.closed = false;
      this.failure = null;
      endpoint.onmessage = message => {
        if (this.endpoint !== endpoint || this.closed) return;
        this.receive(message).catch(() => { if (this.endpoint === endpoint) this.fail('MCP_HOST_TRANSPORT'); });
      };
      endpoint.onclose = () => { if (this.endpoint === endpoint) void this.close(); };
      endpoint.onerror = () => { if (this.endpoint === endpoint) this.fail('MCP_HOST_TRANSPORT'); };
      await endpoint.start();
    }

    async startChild() {
      if (this.starting) return this.starting;
      const createTransport = this.options.createTransport || (params => {
        const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
        return new StdioClientTransport(params);
      });
      const config = this.config;
      if (!config || typeof config.command !== 'string' || !config.command.trim()) {
        this.fail('MCP_HOST_COMMAND');
        return;
      }
      const transport = createTransport({ command: config.command, args: config.args || [],
        ...((config.env || this.options.env) ? { env: Object.fromEntries(Object.entries({ ...this.options.env, ...config.env })
          .filter(([, value]) => typeof value === 'string')) } : {}),
        ...(config.cwd || this.options.cwd ? { cwd: config.cwd || this.options.cwd } : {}),
        stderr: 'pipe', maxBufferSize: 8 * 1024 * 1024 });
      this.childTransport = transport;
      // Drain stderr without logging command lines, credentials, or MCP payloads.
      if (transport.stderr && typeof transport.stderr.resume === 'function') transport.stderr.resume();
      transport.onmessage = message => {
        if (this.closed || this.childTransport !== transport) return;
        if (isRequest(message)) {
          // SDK 0.3.266 matches replies by id before inspecting method. Keep
          // server-origin requests separate from concurrent CLI-origin requests.
          const id = `relay-host:${randomUUID()}`;
          this.reverseRequests.set(id, message.id);
          message = { ...message, id };
        } else if (message.method === 'notifications/cancelled') {
          const id = [...this.reverseRequests].find(([, original]) => original === message.params?.requestId)?.[0];
          if (id) message = { ...message, params: { ...message.params, requestId: id } };
        }
        if (hasId(message) && !message.method) {
          if (this.settled.has(message.id)) return;
          this.finishPending(message.id);
        }
        void this.send(message);
      };
      transport.onerror = () => { if (this.childTransport === transport) this.fail('MCP_HOST_START_FAILED'); };
      transport.onclose = () => { if (!this.closed && this.childTransport === transport) this.fail('MCP_HOST_CLOSED'); };
      // StdioClientTransport starts its child synchronously. Do not defer start
      // into a microtask after close() may already have detached the transport.
      try { this.starting = Promise.resolve(transport.start()); }
      catch (_) { this.starting = Promise.reject(new Error('MCP_HOST_START_FAILED')); }
      this.starting = this.starting.catch(() => this.fail('MCP_HOST_START_FAILED')).then(async () => {
        if (this.closed || this.childTransport !== transport) try { await transport.close(); } catch (_) {}
      });
      await this.starting;
    }

    async receive(message) {
      if (this.closed || !message || typeof message !== 'object') return;
      const endpoint = this.endpoint;
      if (hasId(message) && !message.method && this.reverseRequests.has(message.id)) {
        const original = this.reverseRequests.get(message.id);
        this.reverseRequests.delete(message.id);
        message = { ...message, id: original };
      }
      // A new initialize is an explicit protocol reconnect. Business requests are
      // never retried after a timeout or host failure (they may have had effects).
      if (message.method === 'initialize' && this.failure) {
        await this.stopChild();
        if (this.closed || this.endpoint !== endpoint) return;
        this.failure = null;
      }
      if (isRequest(message)) {
        if (this.pending.has(message.id)) return;
        this.settled.delete(message.id);
        const requestedTimeout = Number(this.config.timeout);
        const toolTimeout = requestedTimeout >= 1000 ? requestedTimeout : Number(this.options.toolTimeoutMs || this.options.env?.MCP_TOOL_TIMEOUT) || 600000;
        const timeout = message.method === 'initialize' ? Number(this.options.connectTimeoutMs) || 10000
          : message.method === 'tools/call' ? toolTimeout : Number(this.options.requestTimeoutMs) || 60000;
        const timer = setTimeout(() => {
          if (!this.pending.has(message.id)) return;
          this.finishPending(message.id);
          this.rememberSettled(message.id);
          void this.sendError(message.id, 'MCP_HOST_TIMEOUT');
          if (this.childTransport && !this.failure) {
            Promise.resolve(this.childTransport.send({ jsonrpc: '2.0', method: 'notifications/cancelled',
              params: { requestId: message.id, reason: 'Request timed out' } })).catch(() => {});
          }
          if (message.method === 'initialize') this.fail('MCP_HOST_TIMEOUT');
        }, timeout);
        timer.unref?.();
        this.pending.set(message.id, timer);
      }
      if (this.failure) {
        if (isRequest(message)) { this.finishPending(message.id); await this.sendError(message.id, this.failure); }
        return;
      }
      if (message.method === 'notifications/cancelled' && hasId({ id: message.params?.requestId })) {
        this.finishPending(message.params.requestId);
        this.rememberSettled(message.params.requestId);
      }
      await this.startChild();
      if (this.closed || this.endpoint !== endpoint || this.failure || (isRequest(message) && !this.pending.has(message.id))) return;
      try { await this.childTransport.send(message); } catch (_) { this.fail('MCP_HOST_TRANSPORT'); }
    }

    finishPending(id) { clearTimeout(this.pending.get(id)); this.pending.delete(id); }
    rememberSettled(id) {
      this.settled.add(id);
      if (this.settled.size > 1024) this.settled.delete(this.settled.values().next().value);
    }
    async send(message) { if (!this.closed) try { await this.endpoint.send(message); } catch (_) { await this.close(); } }
    sendError(id, code) {
      // Native errors can include the full executable, arguments or credentials.
      const reason = code === 'MCP_HOST_TIMEOUT' ? 'Windows MCP 请求超时' : 'Windows MCP 无法连接或连接已关闭';
      return this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: `${reason}（${code}）` } });
    }
    fail(code) {
      if (this.closed || this.failure) return;
      this.failure = code;
      this.reverseRequests.clear();
      for (const id of this.pending.keys()) {
        this.finishPending(id); this.rememberSettled(id); void this.sendError(id, code);
      }
      void this.stopChild();
    }
    stopChild() {
      const child = this.childTransport;
      this.childTransport = null;
      this.starting = null;
      if (!child) return Promise.allSettled([...this.stopping]);
      const closing = Promise.resolve().then(() => child.close()).catch(() => {});
      this.stopping.add(closing);
      closing.finally(() => this.stopping.delete(closing));
      return closing;
    }
    close() {
      if (this.closePromise) return this.closePromise;
      this.closed = true;
      for (const id of this.pending.keys()) this.finishPending(id);
      this.settled.clear();
      this.reverseRequests.clear();
      const starting = this.starting;
      this.closePromise = (async () => {
        await this.stopChild();
        if (starting) await starting;
        await Promise.allSettled([...this.stopping]);
      })();
      return this.closePromise;
    }
  };
}

function bridgeMcpServers(servers, options = {}) {
  return Object.fromEntries(Object.entries(servers || {}).map(([name, config]) => {
    if (!config || config.type === 'sdk' || config.type === 'http' || config.type === 'sse' || config.url) return [name, config];
    const HostStdioMcpServer = getHostServerClass();
    return [name, { type: 'sdk', name, ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      instance: new HostStdioMcpServer(name, config, options) }];
  }));
}

function createRuntimeMcpMapper(initialServers, map) {
  let applied = initialServers || {};
  const owned = new Set(Object.values(applied).filter(config => isHostServer(config?.instance)).map(config => config.instance));
  const mapper = servers => map(servers);
  mapper.applyServers = async (apply, servers) => {
    const next = await mapper(servers);
    for (const config of Object.values(next)) if (isHostServer(config?.instance)) owned.add(config.instance);
    const retired = Object.entries(applied).filter(([name, config]) => isHostServer(config?.instance)
      && config.instance !== next[name]?.instance).map(([, config]) => config.instance);
    // SDK 0.3.266 intentionally retains an existing same-named SDK instance.
    // Remove changed registrations first so its old transport/process closes.
    const replacements = Object.keys(next).filter(name => applied[name]?.type === 'sdk'
      && next[name]?.type === 'sdk' && (applied[name].instance !== next[name].instance || applied[name].timeout !== next[name].timeout));
    if (replacements.length) {
      const intermediate = { ...next };
      for (const name of replacements) delete intermediate[name];
      await apply(intermediate); applied = intermediate;
      await Promise.all(retired.map(instance => instance.close()));
    }
    const result = await apply(next); applied = next;
    await Promise.all(retired.map(instance => instance.close()));
    for (const instance of retired) owned.delete(instance);
    return result;
  };
  mapper.close = () => Promise.allSettled([...owned].map(instance => instance.close()));
  return mapper;
}

module.exports = { get HostStdioMcpServer() { return getHostServerClass(); }, bridgeMcpServers, createRuntimeMcpMapper };
