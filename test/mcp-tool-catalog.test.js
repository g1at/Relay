'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { McpToolCatalog, MCP_TOOL_CATALOG_DEFAULTS } = require('../src/main/sdk/mcp-tool-catalog');

const tool = (name, extra = {}) => ({ name, description: `Perform ${name}`, inputSchema: { type: 'object', properties: {} }, ...extra });
const tools = (count = 17) => Array.from({ length: count }, (_, index) => tool(`tool_${index}`));
const catalog = (entries = tools(), options = {}) => {
  const value = new McpToolCatalog({ serverName: 'Example MCP', ...options });
  value.replace(entries);
  return value;
};
const body = result => JSON.parse(result.result.content[0].text);
const visibleNames = value => value.list().map(entry => entry.name);

test('small catalogs are unchanged, at the count boundary as well', () => {
  for (const count of [0, 1, 16]) {
    const entries = tools(count), value = catalog(entries);
    assert.equal(value.stats().lazy, false);
    assert.deepEqual(value.list(), entries);
    for (let index = 0; index < count; index++) assert.equal(value.list()[index], entries[index]);
    assert.equal(value.discoveryName, null);
    assert.equal(value.discover({ query: 'tool' }).result.isError, true);
    assert.equal(value.replace(entries).changed, false);
  }
});

test('either tool count or full serialized bytes activates discovery', () => {
  assert.equal(catalog().stats().lazy, true);
  const entry = tool('one_large_tool', { inputSchema: { type: 'object', description: 'a'.repeat(25 * 1024) } });
  const value = catalog([entry]);
  assert.equal(value.stats().lazy, true);
  assert.equal(value.stats().hiddenCount, 1);
  assert.equal(value.stats().totalBytes, Buffer.byteLength(JSON.stringify([entry])));
  assert.equal(value.stats().visibleBytes, Buffer.byteLength(JSON.stringify(value.list())));
  assert.ok(value.stats().visibleBytes < 2000);
});

test('explicit server alwaysLoad bypasses lazy discovery without altering original tools', () => {
  const entries = tools(100), value = catalog(entries, { alwaysLoad: true });
  assert.equal(value.stats().lazy, false);
  assert.equal(value.list().length, 100);
  assert.equal(value.list()[30], entries[30]);
});

test('discovery uses bounded standard JSON schema and contains no recursive tool reference', () => {
  const entry = catalog().list()[0];
  assert.match(entry.description, /Example MCP/);
  assert.match(entry.description, /hidden/);
  assert.match(entry.description, /search before invoking/);
  assert.equal(entry._meta['anthropic/alwaysLoad'], true);
  assert.equal(entry.inputSchema.additionalProperties, false);
  assert.equal(entry.inputSchema.properties.query.maxLength, 256);
  assert.equal(entry.inputSchema.properties.names.maxItems, 5);
  assert.equal(entry.inputSchema.properties.limit.maximum, 5);
  assert.doesNotMatch(JSON.stringify(entry), /tool_reference|\$ref/);
});

test('empty query browses paginated summaries without activating original tools', () => {
  const value = catalog(), before = value.list();
  const first = value.discover({});
  assert.deepEqual(body(first).tools.map(entry => entry.name), ['tool_0', 'tool_1', 'tool_2']);
  assert.equal(body(first).nextOffset, 3);
  assert.equal(body(first).total, 17);
  assert.deepEqual(body(first).activated, []);
  assert.equal(first.changed, false);
  const second = value.discover({ query: '  ', offset: 3, limit: 5 });
  assert.deepEqual(body(second).tools.map(entry => entry.name), ['tool_3', 'tool_4', 'tool_5', 'tool_6', 'tool_7']);
  assert.equal(body(second).tools.every(entry => entry.available === false), true);
  assert.deepEqual(value.list(), before);
  assert.equal(body(value.discover({ offset: 17 })).nextOffset, null);
  assert.deepEqual(body(value.discover({ offset: Number.MAX_SAFE_INTEGER })).tools, []);
});

test('search ordering is deterministic with exact names before name tokens and descriptions', () => {
  const value = catalog([
    tool('read_document'), tool('read', { description: 'Read document' }),
    tool('edit', { description: 'read existing text' }), ...tools(),
  ]);
  const result = value.discover({ query: 'read', limit: 5 });
  assert.deepEqual(body(result).tools.map(entry => entry.name), ['read', 'read_document', 'edit']);
  assert.equal(result.changed, true);
  const again = value.discover({ query: 'read', limit: 5 });
  assert.equal(again.changed, false);
  assert.deepEqual(body(again), body(result));
  assert.match(body(result).instruction, /original parameters/);
});

test('Chinese substring searches match original descriptions and paginated query activates only returned page', () => {
  const value = catalog([tool('read_sheet', { description: '读取飞书电子表格内容' }),
    tool('write_sheet', { description: '修改飞书电子表格内容' }), ...tools()]);
  const first = value.discover({ query: '电子表格', limit: 1 });
  assert.deepEqual(body(first).activated, ['read_sheet']);
  assert.deepEqual(visibleNames(value), ['relay_search_tools', 'read_sheet']);
  const second = value.discover({ query: '电子表格', offset: body(first).nextOffset, limit: 1 });
  assert.deepEqual(body(second).activated, ['write_sheet']);
  assert.equal(body(second).nextOffset, null);
  assert.deepEqual(visibleNames(value), ['relay_search_tools', 'read_sheet', 'write_sheet']);
});

test('shared name tokens do not activate unrelated tools from an exact or multiword query', () => {
  const value = catalog([tool('read_document', { description: 'Read a document' }),
    tool('read_mail', { description: 'Read a mailbox' }), ...tools()]);
  assert.deepEqual(body(value.discover({ query: 'tool_16' })).activated, ['tool_16']);
  assert.deepEqual(body(value.discover({ query: 'read document' })).activated, ['read_document']);
  assert.equal(visibleNames(value).includes('read_mail'), false);
  assert.equal(visibleNames(value).includes('tool_0'), false);
});

test('exact selection never substitutes a fuzzy name, and invalid batches activate nothing', () => {
  const value = catalog(), before = value.list();
  for (const names of [['tool'], ['tool_0', 'missing'], ['TOOL_0']]) {
    const result = value.discover({ names });
    assert.equal(result.result.isError, true);
    assert.equal(result.changed, false);
    assert.deepEqual(value.list(), before);
  }
  const result = value.discover({ names: ['tool_3', 'tool_1'] });
  assert.deepEqual(body(result).activated, ['tool_3', 'tool_1']);
  assert.deepEqual(visibleNames(value), ['relay_search_tools', 'tool_1', 'tool_3']);
});

test('all explicit names activate by default while an explicit limit still paginates', () => {
  const names = ['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4'];
  const all = catalog();
  assert.deepEqual(body(all.discover({ names })).activated, names);
  assert.equal(all.stats().activeCount, 5);
  const paged = catalog();
  const first = body(paged.discover({ names, limit: 2 }));
  assert.deepEqual(first.activated, ['tool_0', 'tool_1']);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual(body(paged.discover({ names, offset: first.nextOffset, limit: 2 })).activated, ['tool_2', 'tool_3']);
});

test('known own-server qualified names resolve exactly and expose the SDK callable name', () => {
  const raw = catalog(), qualified = catalog();
  const rawResult = body(raw.discover({ names: ['tool_16'] }));
  const qualifiedResult = body(qualified.discover({ names: ['mcp__Example_MCP__tool_16'] }));
  assert.deepEqual(qualifiedResult, rawResult);
  assert.equal(qualifiedResult.tools[0].qualifiedName, 'mcp__Example_MCP__tool_16');
  assert.deepEqual(body(catalog().discover({ query: 'mcp__Example_MCP__tool_16' })), body(catalog().discover({ query: 'tool_16' })));
  assert.deepEqual(body(catalog().discover({ names: ['tool_16', 'mcp__Example_MCP__tool_16'] })).activated, ['tool_16']);
  const punctuated = catalog(tools(), { serverName: 'feishu-mcp.pro' });
  assert.deepEqual(body(punctuated.discover({ names: ['mcp__feishu-mcp_pro__tool_16'] })).activated, ['tool_16']);
});

test('foreign and missing qualified names cannot fuzzy-match another server or partially activate a batch', () => {
  const value = catalog();
  for (const args of [
    { names: ['mcp__Other__tool_16'] }, { query: 'mcp__Other__tool_16' },
    { names: ['mcp__Example_MCP__tool'] }, { query: 'mcp__Example_MCP__tool' },
    { names: ['tool_16', 'mcp__Other__tool_16'] },
  ]) {
    assert.equal(value.discover(args).result.isError, true);
    assert.equal(value.stats().activeCount, 0);
  }
});

test('existing raw names take precedence over a qualified-looking prefix', () => {
  const fullName = 'mcp__Example_MCP__tool_16';
  const value = catalog([tool(fullName), ...tools()]);
  const result = body(value.discover({ names: [fullName] }));
  assert.deepEqual(result.activated, [fullName]);
  assert.equal(result.tools[0].qualifiedName, 'mcp__Example_MCP__mcp__Example_MCP__tool_16');
  assert.equal(value.list().some(entry => entry.name === 'tool_16'), false);
});

test('no search hits produce a safe error without changing active tools', () => {
  const value = catalog();
  value.discover({ names: ['tool_0'] });
  const before = value.list(), result = value.discover({ query: '找不到的完全不相关能力' });
  assert.equal(result.result.isError, true);
  assert.equal(result.changed, false);
  assert.deepEqual(value.list(), before);
});

test('invalid inputs cannot expand search response size or pollute object prototypes', () => {
  const value = catalog();
  const invalid = [null, [], true, 'tool', { unknown: 1 }, { query: 1 }, { query: 'x'.repeat(257) },
    { names: ['tool_0', 'tool_0'] }, { names: Array(6).fill('tool_0') }, { names: [null] }, { names: [''] },
    { names: 'tool_0' }, { query: 'tool', names: ['tool_0'] }, { offset: -1 }, { offset: 1.5 }, { offset: Infinity },
    { limit: 0 }, { limit: 6 }, { limit: 1.5 }, JSON.parse('{"__proto__":{"polluted":true}}'),
    Object.create({ query: 'tool' })];
  for (const args of invalid) {
    const result = value.discover(args);
    assert.equal(result.result.isError, true, JSON.stringify(args));
    assert.equal(result.changed, false);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(value.stats().activeCount, 0);
});

test('selected schemas and metadata remain intact without mutating originals', () => {
  const original = tool('original', {
    inputSchema: { type: 'object', properties: { mode: { enum: ['a', 'b'] } }, required: ['mode'], additionalProperties: false },
    outputSchema: { type: 'object', required: ['ok'] }, annotations: { destructiveHint: true },
    _meta: { 'anthropic/alwaysLoad': false, custom: { nested: true } }, title: 'Original title',
  });
  const before = JSON.stringify(original), value = catalog([original, ...tools()]);
  const response = value.discover({ names: ['original'] });
  const visible = value.list().find(entry => entry.name === 'original');
  assert.notEqual(visible, original);
  assert.equal(visible.inputSchema, original.inputSchema);
  assert.equal(visible.outputSchema, original.outputSchema);
  assert.equal(visible.annotations, original.annotations);
  assert.equal(visible._meta.custom, original._meta.custom);
  assert.equal(visible._meta['anthropic/alwaysLoad'], true);
  assert.equal(visible.title, original.title);
  assert.equal(JSON.stringify(original), before);
  assert.doesNotMatch(response.result.content[0].text, /inputSchema|required|additionalProperties/);
});

test('large descriptions are searched completely but discovery summaries stay compact', () => {
  const long = 'prefix '.repeat(10000) + 'rare_marker_near_the_end';
  const value = catalog([tool('large', { description: long })]);
  const result = value.discover({ query: 'rare_marker_near_the_end' });
  assert.equal(body(result).tools[0].name, 'large');
  assert.ok(body(result).tools[0].description.length <= 240);
  assert.ok(result.result.content[0].text.length < 1500);
  assert.equal(value.list()[1].description, long);
});

test('tool-level alwaysLoad stays visible and exempt from LRU eviction', () => {
  const pinned = tool('pinned', { _meta: { 'anthropic/alwaysLoad': true, custom: 'retained' } });
  const value = catalog([pinned, ...tools()]);
  assert.deepEqual(visibleNames(value), ['relay_search_tools', 'pinned']);
  assert.equal(value.list()[1], pinned);
  for (let index = 0; index < 17; index++) value.discover({ names: [`tool_${index}`] });
  assert.equal(value.list()[1], pinned);
  assert.equal(value.stats().alwaysLoadCount, 1);
  assert.equal(value.stats().activeCount, 8);
});

test('bounded active window evicts least recently activated tools and repeated selection touches LRU', () => {
  const value = catalog();
  for (let index = 0; index < 8; index++) value.discover({ names: [`tool_${index}`] });
  assert.equal(value.discover({ names: ['tool_0'] }).changed, false);
  value.discover({ names: ['tool_8'] });
  assert.equal(visibleNames(value).includes('tool_0'), true);
  assert.equal(visibleNames(value).includes('tool_1'), false);
  assert.equal(value.stats().activeCount, 8);
  assert.ok(value.stats().activeBytes <= 32 * 1024);
});

test('byte budget evicts old schemas while preserving newly selected original schemas', () => {
  const entries = tools().map(entry => ({ ...entry, inputSchema: { type: 'object', description: 'x'.repeat(12 * 1024) } }));
  const value = catalog(entries);
  value.discover({ names: ['tool_0'] });
  value.discover({ names: ['tool_1'] });
  value.discover({ names: ['tool_2'] });
  assert.equal(value.stats().activeCount, 2);
  assert.ok(value.stats().activeBytes <= 32 * 1024);
  assert.deepEqual(visibleNames(value), ['relay_search_tools', 'tool_1', 'tool_2']);
  assert.equal(value.list()[2].inputSchema, entries[2].inputSchema);
});

test('a single oversized schema remains usable and intact across repeated catalog refreshes', () => {
  const large = tool('huge', { inputSchema: { type: 'object', description: 'x'.repeat(80 * 1024) } });
  const entries = [large, ...tools()], value = catalog(entries);
  const result = value.discover({ names: ['huge'] });
  assert.equal(body(result).oversized, true);
  assert.equal(value.stats().oversized, true);
  assert.equal(value.list()[1].inputSchema, large.inputSchema);
  assert.equal(value.replace(entries).changed, false);
  assert.equal(value.list()[1].inputSchema, large.inputSchema);
  value.discover({ names: ['tool_0'] });
  assert.equal(value.stats().oversized, false);
  assert.deepEqual(visibleNames(value), ['relay_search_tools', 'tool_0']);
});

test('an oversized batch protects every selected tool, then yields to the next selection', () => {
  const entries = tools().map(entry => ({ ...entry, inputSchema: { type: 'object', description: 'x'.repeat(12 * 1024) } }));
  const value = catalog(entries);
  const names = ['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4'];
  const result = value.discover({ names, limit: 5 });
  assert.deepEqual(body(result).activated, names);
  assert.equal(value.stats().activeCount, 5);
  assert.equal(body(result).oversized, true);
  assert.equal(value.replace(entries).changed, false);
  value.discover({ names: ['tool_5'] });
  assert.deepEqual(visibleNames(value), ['relay_search_tools', 'tool_4', 'tool_5']);
});

test('discovery name avoids collisions and remains stable until a real tool occupies it', () => {
  const entries = [tool('relay_search_tools'), tool('relay_search_tools_2'), ...tools()];
  const value = catalog(entries);
  assert.equal(value.discoveryName, 'relay_search_tools_3');
  assert.equal(value.isDiscoveryTool('relay_search_tools'), false);
  assert.equal(value.isDiscoveryTool('relay_search_tools_3'), true);
  value.replace(tools());
  assert.equal(value.discoveryName, 'relay_search_tools_3');
  value.replace([tool('relay_search_tools_3'), ...tools()]);
  assert.equal(value.discoveryName, 'relay_search_tools');
  assert.equal(value.isDiscoveryTool('relay_search_tools_3'), false);
  const original = value.discover({ names: ['relay_search_tools_3'] });
  assert.deepEqual(body(original).activated, ['relay_search_tools_3']);
});

test('catalog replacement retains surviving selections, updates schemas, and removes deleted names', () => {
  const value = catalog();
  value.discover({ names: ['tool_0', 'tool_1'] });
  const updated = tool('tool_0', { inputSchema: { type: 'object', required: ['new'] } });
  assert.equal(value.replace([updated, ...tools().slice(2)]).changed, true);
  assert.equal(value.stats().lazy, false, '16 remaining small tools revert to eager');
  assert.equal(value.list()[0], updated);
  assert.equal(value.list().some(entry => entry.name === 'tool_1'), false);
  value.replace([updated, ...tools().slice(1)]);
  value.discover({ names: ['tool_0', 'tool_1'] });
  assert.equal(value.replace([updated, ...tools().slice(2), tool('new_tool')]).changed, true);
  assert.deepEqual(visibleNames(value), ['relay_search_tools', 'tool_0']);
  assert.equal(value.list()[1].inputSchema, updated.inputSchema);
});

test('special names are map keys and independent instances never share activations', () => {
  const entries = [tool('__proto__'), tool('constructor'), ...tools()];
  const first = catalog(entries), second = catalog(entries);
  first.discover({ names: ['__proto__', 'constructor'] });
  assert.equal(first.stats().activeCount, 2);
  assert.equal(second.stats().activeCount, 0);
  assert.deepEqual(visibleNames(first), ['relay_search_tools', '__proto__', 'constructor']);
  assert.deepEqual(visibleNames(second), ['relay_search_tools']);
  assert.equal(first.reset().changed, true);
  assert.deepEqual(first.list(), []);
  assert.equal(first.reset().changed, false);
  first.replace(entries);
  assert.equal(first.stats().activeCount, 0);
});

test('invalid replacements leave the current catalog and selections unchanged', () => {
  const value = catalog();
  value.discover({ names: ['tool_0'] });
  const cyclic = tool('cycle'); cyclic.inputSchema.self = cyclic;
  const before = value.list();
  for (const entries of [null, {}, [null], [tool('')], [tool('same'), tool('same')], [cyclic]]) {
    assert.throws(() => value.replace(entries), TypeError);
    assert.deepEqual(value.list(), before);
  }
});

test('defaults are immutable and optional settings cannot loosen protocol limits', () => {
  assert.equal(Object.isFrozen(MCP_TOOL_CATALOG_DEFAULTS), true);
  assert.throws(() => new McpToolCatalog({ maxActiveTools: 0 }), TypeError);
  const value = catalog(tools(), { maxResults: 100, maxQueryLength: 1000, maxDescriptionLength: 1000 });
  assert.equal(value.list()[0].inputSchema.properties.limit.maximum, 5);
  assert.equal(value.discover({ limit: 6 }).result.isError, true);
  assert.equal(value.discover({ query: 'x'.repeat(257) }).result.isError, true);
});
