'use strict';

const { randomUUID } = require('node:crypto');
const { projectMcpToolsList } = require('./sdk-mcp-schema-compat');
const { McpToolCatalog } = require('./mcp-tool-catalog');
const { getHostMcpLoopbackOwner } = require('./host-mcp-loopback');

const hasId = message => message && message.id !== undefined && message.id !== null;
const isRequest = message => hasId(message) && typeof message.method === 'string';
let HostServerClass;
let DeferredHostServerClass;
const isHostServer = instance => !!HostServerClass && instance instanceof HostServerClass;
const hostInstance = config => getHostMcpLoopbackOwner(config)?.instance || config?.instance;
const hostResource = config => getHostMcpLoopbackOwner(config) || (isHostServer(config?.instance) ? config.instance : null);
const hostStatusMatches = (config, item, strict = false) => getHostMcpLoopbackOwner(config)?.matchesStatus(item)
  ?? (item.source === 'sdk' || (!strict && item.source == null));

// Most launches only need routing helpers. Loading McpServer here also loads
// its schema validators; wait until a Windows stdio bridge is actually needed.
// Cache the real SDK subclass so existing instances keep their identity during
// runtime replacement, ownership checks and shutdown.
function getHostServerClass() {
  if (HostServerClass) return HostServerClass;
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

  // The agent SDK supplies a bidirectional Transport for an in-process McpServer.
  // This server relays that transport to a host-owned stdio MCP. Large catalogs
  // expose a local discovery tool first, then original schemas with the existing
  // equivalent discriminator projection. Business names/arguments/results remain
  // verbatim, so SDK permissions still apply; business calls are never replayed.
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
      this.toolListRequests = new Set();
      this.initializeRequests = new Set();
      this.toolListPages = new Map();
      this.discoveryRequests = new Map();
      this.catalogRevision = 0;
      this.publishedRevision = 0;
      this.discoveryTail = Promise.resolve();
      this.toolCatalog = new McpToolCatalog({ serverName: name, alwaysLoad: config.alwaysLoad === true });
      this.settled = new Set();
      this.reverseRequests = new Map();
      this.failure = null;
      this.closed = true;
      this.closePromise = null;
      this.stopping = new Set();
      this.closingChildren = new Set();
      this.childClosures = new WeakMap();
      this.childExits = new WeakMap();
    }

    async connect(endpoint) {
      if (this.endpoint && !this.closed) throw new Error('MCP host bridge is already connected');
      if (this.closePromise) await this.closePromise;
      this.closePromise = null;
      this.endpoint = endpoint;
      this.catalogRevision = 0;
      this.publishedRevision = 0;
      this.discoveryTail = Promise.resolve();
      this.closed = false;
      this.failure = null;
      endpoint.onmessage = message => {
        if (this.endpoint !== endpoint || this.closed) return;
        this.receive(message).catch(() => { if (this.endpoint === endpoint) this.fail('MCP_HOST_TRANSPORT'); });
      };
      endpoint.onclose = () => { if (this.endpoint === endpoint) void this.close().catch(() => {}); };
      endpoint.onerror = () => { if (this.endpoint === endpoint) this.fail('MCP_HOST_TRANSPORT'); };
      await endpoint.start();
    }

    async startChild() {
      if (this.starting) return this.starting;
      const createTransport = this.options.createTransport || (params => {
        return require('./host-stdio-transport').createHostStdioTransport(params);
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
      let confirmExit;
      const nativeExit = { required: false, promise: new Promise(resolve => { confirmExit = resolve; }) };
      this.childExits.set(transport, nativeExit);
      // Drain stderr without logging command lines, credentials, or MCP payloads.
      if (transport.stderr && typeof transport.stderr.resume === 'function') transport.stderr.resume();
      transport.onmessage = message => {
        this.receiveChild(message, transport).catch(() => {
          if (!this.closed && this.childTransport === transport) this.fail('MCP_HOST_TRANSPORT');
        });
      };
      transport.onerror = () => { if (this.childTransport === transport) this.fail('MCP_HOST_START_FAILED'); };
      transport.onclose = () => { confirmExit(); if (!this.closed && this.childTransport === transport) this.fail('MCP_HOST_CLOSED'); };
      // StdioClientTransport starts its child synchronously. Do not defer start
      // into a microtask after close() may already have detached the transport.
      try {
        this.starting = Promise.resolve(transport.start());
        // Native stdio close() can return immediately after SIGKILL. Its
        // onclose observation, not a detached/null pid, proves release.
        nativeExit.required = !!transport.relayProcessTree || Number.isInteger(transport.pid) && transport.pid > 0;
      }
      catch (_) { this.starting = Promise.reject(new Error('MCP_HOST_START_FAILED')); }
      this.starting = this.starting.catch(() => this.fail('MCP_HOST_START_FAILED')).then(async () => {
        if (this.closed || this.childTransport !== transport) await this.stopChild();
      });
      await this.starting;
    }

    async receiveChild(message, transport) {
      if (this.closed || this.childTransport !== transport) return;
      const endpoint = this.endpoint;
      if (isRequest(message)) {
        const id = `relay-host:${randomUUID()}`;
        this.reverseRequests.set(id, message.id);
        message = { ...message, id };
      } else if (message.method === 'notifications/cancelled') {
        const id = [...this.reverseRequests].find(([, original]) => original === message.params?.requestId)?.[0];
        if (id) message = { ...message, params: { ...message.params, requestId: id } };
      }
      let catalogPublished = false;
      let revision = 0;
      if (hasId(message) && !message.method) {
        if (this.settled.has(message.id)) return;
        if (this.initializeRequests.has(message.id) && message.result?.capabilities?.tools) {
          // Discovery belongs to the bridge even when the upstream list is static.
          message = { ...message, result: { ...message.result, capabilities: {
            ...message.result.capabilities, tools: { ...message.result.capabilities.tools, listChanged: true },
          } } };
        }
        if (this.toolListRequests.has(message.id) && Array.isArray(message.result?.tools)) {
          const page = this.toolListPages.get(message.id) || { tools: [], cursors: new Set(), bytes: 0 };
          const nextCount = page.tools.length + message.result.tools.length;
          const nextBytes = page.bytes + Buffer.byteLength(JSON.stringify(message.result.tools));
          if (nextCount > 10000 || nextBytes > 32 * 1024 * 1024 || page.cursors.size >= 128) {
            this.finishPending(message.id); this.rememberSettled(message.id);
            await this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'MCP tool catalog exceeds the supported listing limit.' } });
            return;
          }
          page.tools.push(...message.result.tools); page.bytes = nextBytes;
          if (message.result.nextCursor != null) {
            const cursor = message.result.nextCursor;
            if (typeof cursor !== 'string' || !cursor || page.cursors.has(cursor)) {
              this.finishPending(message.id); this.rememberSettled(message.id);
              await this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'MCP tool catalog returned an invalid or repeated page cursor.' } });
              return;
            }
            page.cursors.add(cursor); this.toolListPages.set(message.id, page);
            await transport.send({ jsonrpc: '2.0', id: message.id, method: 'tools/list', params: { cursor } });
            return;
          }
          const { nextCursor, ...result } = message.result;
          message = projectMcpToolsList({ ...message, result: { ...result, tools: page.tools } }, { alwaysLoad: this.config.alwaysLoad === true });
          try { this.toolCatalog.replace(message.result.tools); }
          catch (_) {
            this.finishPending(message.id); this.rememberSettled(message.id);
            await this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'MCP tool catalog contains invalid or duplicate definitions.' } });
            return;
          }
          message = { ...message, result: { ...message.result, tools: this.toolCatalog.list() } };
          catalogPublished = true; revision = this.catalogRevision;
        }
        this.finishPending(message.id);
      }
      const catalogPublishedToEndpoint = catalogPublished
        && !(typeof this.isInternalCatalogResponse === 'function' && this.isInternalCatalogResponse(message.id));
      await this.send(message);
      if (catalogPublishedToEndpoint && !this.closed && this.endpoint === endpoint && this.childTransport === transport) {
        this.publishedRevision = Math.max(this.publishedRevision, revision);
        for (const request of this.discoveryRequests.values()) {
          if (request.revision <= this.publishedRevision) request.resolve();
        }
      }
    }

    async discover(message) {
      const endpoint = this.endpoint;
      const requestToken = this.pending.get(message.id);
      const current = () => !this.closed && !this.failure && this.endpoint === endpoint
        && this.pending.get(message.id) === requestToken;
      const work = async () => {
        if (!current()) return;
        const outcome = this.toolCatalog.discover(message.params?.arguments);
        if (outcome.changed) this.catalogRevision++;
        if (!outcome.result.isError && (outcome.changed || this.publishedRevision < this.catalogRevision)) {
          const revision = this.catalogRevision;
          let resolve, reject;
          const refreshed = new Promise((yes, no) => { resolve = yes; reject = no; });
          refreshed.catch(() => {}); // close() can reject while endpoint.send is still awaited
          const request = { revision, resolve, reject };
          this.discoveryRequests.set(message.id, request);
          try {
            // Do not finish discovery until the SDK receives the updated list.
            // The request timer handles clients without refresh support.
            await this.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
            await refreshed;
          } catch (_) { return; }
          finally { if (this.discoveryRequests.get(message.id) === request) this.discoveryRequests.delete(message.id); }
        }
        if (!current()) return;
        if (!outcome.result.isError) {
          const activated = JSON.parse(outcome.result.content[0].text).activated || [];
          const visible = new Set(this.toolCatalog.list().map(tool => tool.name));
          if (activated.some(name => !visible.has(name))) outcome.result = { isError: true,
            content: [{ type: 'text', text: 'The server tool catalog changed during discovery. Search again before calling the selected tool.' }] };
        }
        this.finishPending(message.id);
        await this.send({ jsonrpc: '2.0', id: message.id, result: outcome.result });
      };
      const next = this.discoveryTail.then(work);
      this.discoveryTail = next.catch(() => {});
      await next;
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
      const discovery = message.method === 'tools/call' && this.toolCatalog.isDiscoveryTool(message.params?.name);
      if (isRequest(message)) {
        if (this.pending.has(message.id)) return;
        this.settled.delete(message.id);
        const requestedTimeout = Number(this.config.timeout);
        const toolTimeout = requestedTimeout >= 1000 ? requestedTimeout : Number(this.options.toolTimeoutMs || this.options.env?.MCP_TOOL_TIMEOUT) || 600000;
        const timeout = discovery ? Number(this.options.discoveryTimeoutMs) || 8000
          : message.method === 'initialize' ? Number(this.options.connectTimeoutMs) || 10000
          : message.method === 'tools/call' ? toolTimeout : Number(this.options.requestTimeoutMs) || 60000;
        const timer = setTimeout(() => {
          if (this.pending.get(message.id) !== timer) return;
          this.finishPending(message.id);
          this.rememberSettled(message.id);
          if (discovery) void this.send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Tool discovery refresh timed out. No business tool was executed. Retry discovery before calling the selected tool.' }] } });
          else void this.sendError(message.id, 'MCP_HOST_TIMEOUT');
          if (!discovery && this.childTransport && !this.failure) {
            Promise.resolve(this.childTransport.send({ jsonrpc: '2.0', method: 'notifications/cancelled',
              params: { requestId: message.id, reason: 'Request timed out' } })).catch(() => {});
          }
          if (message.method === 'initialize') this.fail('MCP_HOST_TIMEOUT');
        }, timeout);
        timer.unref?.();
        this.pending.set(message.id, timer);
        if (message.method === 'tools/list') this.toolListRequests.add(message.id);
        if (message.method === 'initialize') this.initializeRequests.add(message.id);
      }
      if (this.failure) {
        if (isRequest(message)) { this.finishPending(message.id); await this.sendError(message.id, this.failure); }
        return;
      }
      if (message.method === 'notifications/cancelled' && hasId({ id: message.params?.requestId })) {
        const local = this.discoveryRequests.has(message.params.requestId);
        this.finishPending(message.params.requestId);
        this.rememberSettled(message.params.requestId);
        if (local) return;
      }
      if (discovery && isRequest(message)) { await this.discover(message); return; }
      await this.startChild();
      if (this.closed || this.endpoint !== endpoint || this.failure || (isRequest(message) && !this.pending.has(message.id))) return;
      try { await this.childTransport.send(message); } catch (_) { this.fail('MCP_HOST_TRANSPORT'); }
    }

    finishPending(id) {
      clearTimeout(this.pending.get(id)); this.pending.delete(id);
      this.toolListRequests.delete(id); this.initializeRequests.delete(id); this.toolListPages.delete(id);
      const discovery = this.discoveryRequests.get(id);
      if (discovery) { this.discoveryRequests.delete(id); discovery.reject(new Error('MCP_DISCOVERY_CANCELED')); }
    }
    rememberSettled(id) {
      this.settled.add(id);
      if (this.settled.size > 1024) this.settled.delete(this.settled.values().next().value);
    }
    async send(message) {
      const endpoint = this.endpoint;
      if (!this.closed) try { await endpoint.send(message); }
      catch (_) { if (this.endpoint === endpoint) await this.close(); }
    }
    sendError(id, code) {
      // Native errors can include the full executable, arguments or credentials.
      const reason = code === 'MCP_HOST_TIMEOUT' ? 'Windows MCP 请求超时' : 'Windows MCP 无法连接或连接已关闭';
      return this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: `${reason}（${code}）` } });
    }
    fail(code) {
      if (this.closed || this.failure) return;
      this.failure = code;
      this.toolCatalog.reset();
      this.reverseRequests.clear();
      for (const id of this.pending.keys()) {
        this.finishPending(id); this.rememberSettled(id); void this.sendError(id, code);
      }
      void this.stopChild().catch(() => {});
    }
    stopChild() {
      const child = this.childTransport;
      this.childTransport = null;
      this.starting = null;
      if (child) this.closingChildren.add(child);
      for (const transport of this.closingChildren) {
        if (this.childClosures.has(transport)) continue;
        const closing = Promise.resolve().then(() => transport.close()).then(async () => {
          const nativeExit = this.childExits.get(transport);
          if (nativeExit?.required) await nativeExit.promise;
        });
        this.childClosures.set(transport, closing);
        this.stopping.add(closing);
        closing.then(() => {
          this.closingChildren.delete(transport); this.stopping.delete(closing);
          this.childClosures.delete(transport);
        }, () => {
          // Keep the transport owned after a failed close so an explicit retry
          // can release it. Never turn that rejection into cleanup success.
          this.stopping.delete(closing); this.childClosures.delete(transport);
        });
      }
      return Promise.all([...this.stopping]);
    }

    close() {
      if (this.closePromise) return this.closePromise;
      this.closed = true;
      this.toolCatalog.reset();
      for (const id of this.pending.keys()) this.finishPending(id);
      this.settled.clear();
      this.reverseRequests.clear();
      const starting = this.starting;
      this.closePromise = (async () => {
        await this.stopChild();
        if (starting) await starting;
        await Promise.all([...this.stopping]);
      })();
      const closing = this.closePromise;
      closing.catch(() => { if (this.closePromise === closing) this.closePromise = null; });
      return closing;
    }
  };
}

function bridgeMcpServers(servers, options = {}) {
  return Object.fromEntries(Object.entries(servers || {}).map(([name, config]) => {
    if (!config || config.type === 'sdk' || config.type === 'http' || config.type === 'sse' || config.url) return [name, config];
    const BaseHostServer = getHostServerClass();
    const HostStdioMcpServer = options.deferConnect === true && config.alwaysLoad !== true
      ? (DeferredHostServerClass ||= require('./deferred-stdio-mcp').createDeferredHostServerClass(BaseHostServer))
      : BaseHostServer;
    return [name, { type: 'sdk', name, ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      instance: new HostStdioMcpServer(name, config, options) }];
  }));
}

function getMcpDiscoveryTools(servers) {
  return Object.entries(servers || {}).flatMap(([name, config]) => {
    const instance = hostInstance(config);
    if (!isHostServer(instance) || !instance.toolCatalog?.discoveryName) return [];
    const prefix = `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
    return [{ server: name, name: prefix + instance.toolCatalog.discoveryName }];
  });
}
function createRuntimeMcpMapper(initialServers, map) {
  let applied = initialServers || {};
  const owned = new Set(Object.values(applied).map(hostResource).filter(Boolean));
  const mappings = new Set();
  let closed = false, closing;
  let statusReader;
  const bindReader = servers => { for (const config of Object.values(servers)) getHostMcpLoopbackOwner(config)?.setStatusReader(statusReader); };
  bindReader(applied);
  const mapper = async servers => {
    if (closed) throw new Error('MCP_MAPPER_CLOSED');
    const work = (async () => {
      const next = await map(servers);
      const resources = Object.values(next).map(hostResource).filter(Boolean);
      for (const resource of resources) owned.add(resource);
      if (closed) throw new Error('MCP_MAPPER_CLOSED');
      return next;
    })();
    mappings.add(work);
    try { return await work; } finally { mappings.delete(work); }
  };
  mapper.applyServers = async (apply, servers) => {
    const next = await mapper(servers);
    bindReader(next);
    for (const config of Object.values(next)) if (hostResource(config)) owned.add(hostResource(config));
    const retired = Object.entries(applied).filter(([name, config]) => hostResource(config)
      && hostResource(config) !== hostResource(next[name])).map(([, config]) => hostResource(config));
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
  // A connected SDK transport is only the lightweight front end until this
  // Query actually needs the upstream. Never overwrite policy/transport errors
  // or a same-named server from another configuration source.
  mapper.discoveryTools = () => closed ? [] : getMcpDiscoveryTools(applied);
  mapper.setStatusReader = reader => { statusReader = reader; bindReader(applied); };
  mapper.decorateStatus = statuses => Array.isArray(statuses) ? statuses.map(item => {
    const config = applied[item?.name], instance = hostInstance(config);
    if (item?.status !== 'connected' || !hostStatusMatches(config, item)
      || !isHostServer(instance) || typeof instance.connectionState !== 'function') return item;
    return { ...item, status: instance.connectionState() };
  }) : statuses;
  mapper.handlesReconnect = name => {
    const instance = hostInstance(applied[name]);
    return isHostServer(instance) && typeof instance.connectUpstream === 'function';
  };
  mapper.connectUpstream = async (name, readStatus) => {
    const instance = hostInstance(applied[name]);
    if (!isHostServer(instance) || typeof instance.connectUpstream !== 'function') return;
    // A reconnect acknowledgement is void, not proof that policy accepted this
    // registration. Inspect the raw SDK result before starting any host process.
    const statuses = typeof readStatus === 'function' ? await readStatus() : [];
    if (!Array.isArray(statuses) || !statuses.some(item => item?.name === name
      && hostStatusMatches(applied[name], item, true) && item.status === 'connected') || hostInstance(applied[name]) !== instance) {
      throw new Error('MCP_UPSTREAM_REGISTRATION_NOT_READY');
    }
    await instance.connectUpstream({ reconnect: true });
  };
  mapper.close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      // Admission is closed. Pending mappings must settle before the complete
      // owned set is closed, including resources created during cancellation.
      await Promise.allSettled([...mappings]);
      const results = await Promise.allSettled([...owned].map(async resource => {
        const receipt = await resource.close();
        if (receipt?.stopConfirmed === false || receipt?.ok === false) throw new Error('MCP_RESOURCE_CLOSE_UNCONFIRMED');
        owned.delete(resource);
      }));
      if (results.some(result => result.status === 'rejected')) throw new Error('MCP_RESOURCE_CLOSE_FAILED');
    })();
    const operation = closing;
    operation.catch(() => { if (closing === operation) closing = null; });
    return operation;
  };
  return mapper;
}

module.exports = { get HostStdioMcpServer() { return getHostServerClass(); }, isHostStdioMcpServer: isHostServer, bridgeMcpServers, createRuntimeMcpMapper, getMcpDiscoveryTools };
