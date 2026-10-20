'use strict';

const MCP_TOOL_CATALOG_DEFAULTS = Object.freeze({
  lazyToolCount: 16,
  lazyToolBytes: 24 * 1024,
  maxActiveTools: 8,
  maxActiveBytes: 32 * 1024,
  maxResults: 5,
  defaultLimit: 3,
  maxQueryLength: 256,
  maxDescriptionLength: 240,
});

const ALWAYS_LOAD = 'anthropic/alwaysLoad';
const DISCOVERY_NAME = 'relay_search_tools';
const INPUT_FIELDS = new Set(['query', 'names', 'offset', 'limit']);
const textResult = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});
const compactDescription = (value, limit) => {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
const normalize = value => value.normalize('NFKC').toLowerCase();
const tokenize = value => normalize(value.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const arrayBytes = (records, field) => 2 + records.reduce((sum, record) => sum + record[field], 0)
  + Math.max(0, records.length - 1);

// This bounds the *current advertised list*, not the complete SDK/model context.
// The SDK retains advertised schemas in its per-Query declaration cache, even
// unused schemas and across /compact. Tools
// explicitly marked alwaysLoad, or a selected batch larger than the byte budget,
// are kept intact: argument validation must never be weakened to fit a budget.
class McpToolCatalog {
  constructor(options = {}) {
    this.options = { ...MCP_TOOL_CATALOG_DEFAULTS };
    for (const key of Object.keys(this.options)) {
      if (options[key] !== undefined) {
        if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new TypeError(`Invalid MCP catalog option: ${key}`);
        this.options[key] = options[key];
      }
    }
    // Protocol response/query limits remain bounded even with test/host options.
    this.options.maxResults = Math.min(5, this.options.maxResults);
    this.options.defaultLimit = Math.min(this.options.maxResults, this.options.defaultLimit);
    this.options.maxQueryLength = Math.min(256, this.options.maxQueryLength);
    this.options.maxDescriptionLength = Math.min(240, this.options.maxDescriptionLength);
    this.serverName = compactDescription(options.serverName || 'MCP server', 120);
    this.toolPrefix = `mcp__${String(options.serverName || 'MCP server').replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
    this.alwaysLoad = options.alwaysLoad === true;
    this.records = new Map();
    this.active = new Map();
    this.selection = new Set();
    this.lazy = false;
    this.discovery = null;
    this.preferredDiscoveryName = DISCOVERY_NAME;
  }

  get discoveryName() { return this.discovery?.name || null; }
  isDiscoveryTool(name) { return !!this.discovery && name === this.discovery.name; }

  replace(tools) {
    if (!Array.isArray(tools)) throw new TypeError('MCP tools must be an array');
    const before = this.visibleSignature();
    const records = new Map();
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)
        || typeof tool.name !== 'string' || !tool.name || records.has(tool.name)) {
        throw new TypeError('MCP tools require unique nonempty names');
      }
      let serialized;
      try { serialized = JSON.stringify(tool); }
      catch (_) { throw new TypeError('MCP tools must be JSON serializable'); }
      const pinned = tool._meta?.[ALWAYS_LOAD] === true;
      const visible = pinned ? tool : { ...tool, _meta: { ...tool._meta, [ALWAYS_LOAD]: true } };
      const visibleSerialized = pinned ? serialized : JSON.stringify(visible);
      records.set(tool.name, {
        tool, visible, serialized, visibleSerialized, pinned,
        bytes: Buffer.byteLength(serialized), visibleBytes: Buffer.byteLength(visibleSerialized),
        name: normalize(tool.name), nameTokens: new Set(tokenize(tool.name)),
        description: typeof tool.description === 'string' ? normalize(tool.description) : '',
      });
    }
    this.records = records;
    this.lazy = !this.alwaysLoad && (records.size > this.options.lazyToolCount
      || arrayBytes([...records.values()], 'bytes') > this.options.lazyToolBytes);
    for (const name of this.active.keys()) if (!records.has(name) || records.get(name).pinned) this.active.delete(name);
    for (const name of this.selection) if (!records.has(name)) this.selection.delete(name);
    if (this.lazy) {
      let name = this.preferredDiscoveryName;
      if (records.has(name)) {
        let suffix = 2;
        name = DISCOVERY_NAME;
        while (records.has(name)) name = `${DISCOVERY_NAME}_${suffix++}`;
      }
      this.preferredDiscoveryName = name;
      this.discovery = this.createDiscovery(name);
      this.trimActive(this.selection);
    } else {
      this.discovery = null;
      this.active.clear();
      this.selection.clear();
    }
    return { changed: before !== this.visibleSignature() };
  }

  createDiscovery(name) {
    return {
      name,
      description: `Discover ${this.records.size} tools from ${this.serverName}. Most tools are hidden; search before invoking them. `
        + 'Use query or exact names to load original tools, then call the returned original name. Empty query browses without loading.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: this.options.maxQueryLength, description: 'Tool name or capability keywords; empty browses without loading.' },
          names: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', minLength: 1 }, description: 'Exact original names or this server\'s qualified MCP names; use instead of query.' },
          offset: { type: 'integer', minimum: 0, description: 'Search result offset, default 0.' },
          limit: { type: 'integer', minimum: 1, maximum: this.options.maxResults,
            description: `Maximum returned tools. Defaults to ${this.options.defaultLimit} for search/browse, or all explicit names.` },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { [ALWAYS_LOAD]: true },
    };
  }

  visibleRecords() {
    return [...this.records.values()].filter(record => !this.lazy || record.pinned || this.active.has(record.tool.name));
  }

  list() {
    const tools = this.visibleRecords().map(record => this.lazy ? record.visible : record.tool);
    return this.discovery ? [this.discovery, ...tools] : tools;
  }

  visibleSignature() {
    return JSON.stringify([this.discovery, ...this.visibleRecords().map(record => this.lazy ? record.visibleSerialized : record.serialized)]);
  }

  validate(args) {
    if (args === undefined) args = {};
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
      || Object.keys(args).some(key => !INPUT_FIELDS.has(key))) return { error: 'Expected only query, names, offset and limit.' };
    const query = Object.hasOwn(args, 'query') ? args.query : '';
    const names = Object.hasOwn(args, 'names') ? args.names : [];
    const offset = Object.hasOwn(args, 'offset') ? args.offset : 0;
    const limit = Object.hasOwn(args, 'limit') ? args.limit
      : Array.isArray(names) && names.length ? Math.min(names.length, this.options.maxResults) : this.options.defaultLimit;
    if (typeof query !== 'string' || query.length > this.options.maxQueryLength) return { error: `query must be a string of at most ${this.options.maxQueryLength} characters.` };
    if (!Array.isArray(names) || names.length > 5 || names.some(name => typeof name !== 'string' || !name)
      || new Set(names).size !== names.length) return { error: 'names must contain at most 5 unique, exact nonempty tool names.' };
    if (names.length && query.trim()) return { error: 'Use query or names, not both.' };
    if (!Number.isSafeInteger(offset) || offset < 0) return { error: 'offset must be a nonnegative safe integer.' };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.options.maxResults) return { error: `limit must be an integer from 1 to ${this.options.maxResults}.` };
    return { query: query.trim(), names, offset, limit };
  }

  score(record, query, tokens) {
    if (record.name === query) return 100000;
    // Shared prefixes such as "tool" or "get" must not activate unrelated
    // schemas when the rest of a requested name/capability does not match.
    if (tokens.some(token => !record.name.includes(token) && !record.description.includes(token))) return 0;
    let score = record.name.includes(query) ? 10000 : 0;
    if (record.description.includes(query)) score += 1000;
    for (const token of tokens) {
      if (record.nameTokens.has(token)) score += 500;
      else if (record.name.includes(token)) score += 200;
      if (record.description.includes(token)) score += 20;
    }
    return score;
  }

  resolveName(name) {
    if (this.records.has(name)) return name;
    if (name.startsWith(this.toolPrefix)) {
      const original = name.slice(this.toolPrefix.length);
      if (this.records.has(original)) return original;
    }
    return null;
  }

  discover(args) {
    const invalid = error => ({ result: textResult({ error }, true), changed: false });
    if (!this.lazy) return invalid('Tool discovery is unavailable because all original tools are already listed.');
    const request = this.validate(args);
    if (request.error) return invalid(request.error);
    let { query } = request;
    const { names, offset, limit } = request;
    if (query.startsWith('mcp__') && !this.records.has(query)) {
      const original = this.resolveName(query);
      if (!original) return invalid('Qualified tool name is not an exact tool from this server. Browse this catalog or use the matching server.');
      query = original;
    }
    let matches;
    if (names.length) {
      const resolved = names.map(name => this.resolveName(name));
      if (resolved.includes(null)) return invalid('One or more exact tool names do not exist in this server. Browse or search the catalog before selecting names.');
      matches = [...new Set(resolved)].map(name => this.records.get(name));
    } else if (query) {
      const normalized = normalize(query), tokens = tokenize(query);
      matches = [...this.records.values()].map((record, index) => ({ record, index, score: this.score(record, normalized, tokens) }))
        .filter(match => match.score > 0).sort((left, right) => right.score - left.score || left.index - right.index).map(match => match.record);
    } else matches = [...this.records.values()];
    if ((query || names.length) && !matches.length) return invalid('No matching tools found. Try a shorter keyword or browse with an empty query.');
    const selected = matches.slice(offset, offset + limit);
    const before = this.visibleSignature();
    if ((query || names.length) && selected.length) {
      const protectedNames = new Set(selected.map(record => record.tool.name));
      this.selection = protectedNames;
      for (const record of selected) {
        if (record.pinned) continue;
        this.active.delete(record.tool.name);
        this.active.set(record.tool.name, true);
      }
      this.trimActive(protectedNames);
    }
    const state = this.stats();
    return {
      changed: before !== this.visibleSignature(),
      result: textResult({
        tools: selected.map(record => ({
          name: record.tool.name,
          qualifiedName: `${this.toolPrefix}${record.tool.name}`,
          description: compactDescription(record.tool.description, this.options.maxDescriptionLength),
          available: record.pinned || this.active.has(record.tool.name),
        })),
        total: matches.length, offset,
        nextOffset: offset + selected.length < matches.length ? offset + selected.length : null,
        activated: query || names.length ? selected.map(record => record.tool.name) : [],
        instruction: query || names.length
          ? 'The returned original tools are now available in tools/list. Call the original tool name with its original parameters. No business operation has run.'
          : 'Browse only: select exact names or search with a nonempty query to make the original tools available before invoking them.',
        ...(state.oversized ? { oversized: true, note: 'Selected or always-loaded schemas exceed the active budget and remain intact. The SDK may retain any advertised schema, even unused, in its Query cache across compaction.' } : {}),
      }),
    };
  }

  trimActive(protectedNames) {
    let bytes = arrayBytes([...this.active.keys()].map(name => this.records.get(name)), 'visibleBytes');
    for (const name of this.active.keys()) {
      if (this.active.size <= this.options.maxActiveTools && bytes <= this.options.maxActiveBytes) break;
      if (protectedNames.has(name)) continue;
      bytes -= this.records.get(name).visibleBytes + (this.active.size > 1 ? 1 : 0);
      this.active.delete(name);
    }
  }

  stats() {
    const records = [...this.records.values()];
    const active = records.filter(record => this.active.has(record.tool.name));
    const pinned = records.filter(record => record.pinned);
    const visible = this.visibleRecords();
    const activeBytes = arrayBytes(active, 'visibleBytes');
    const alwaysLoadBytes = arrayBytes(pinned, 'visibleBytes');
    return {
      lazy: this.lazy, totalCount: records.length, totalBytes: arrayBytes(records, 'bytes'),
      activeCount: active.length, activeBytes,
      alwaysLoadCount: pinned.length, alwaysLoadBytes,
      visibleCount: visible.length + (this.discovery ? 1 : 0), visibleBytes: Buffer.byteLength(JSON.stringify(this.list())),
      hiddenCount: records.length - visible.length, discoveryName: this.discoveryName,
      oversized: this.lazy && (active.length > this.options.maxActiveTools || activeBytes > this.options.maxActiveBytes
        || pinned.length > this.options.maxActiveTools || alwaysLoadBytes > this.options.maxActiveBytes),
    };
  }

  reset() {
    const changed = this.records.size > 0 || this.discovery !== null;
    this.records.clear();
    this.active.clear();
    this.selection.clear();
    this.lazy = false;
    this.discovery = null;
    this.preferredDiscoveryName = DISCOVERY_NAME;
    return { changed };
  }
}

module.exports = { McpToolCatalog, MCP_TOOL_CATALOG_DEFAULTS };
