'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { projectToolInputSchema, projectMcpToolsList } = require('../src/main/sdk/sdk-mcp-schema-compat');

const branch = (tag, field = 'action') => ({
  type: 'object', properties: { [field]: Array.isArray(tag) ? { enum: tag } : { const: tag }, value: { type: 'integer', minimum: 0 } },
  required: [field, 'value'], additionalProperties: false,
});
const fixture = () => ({
  type: 'object', properties: { actions: { $ref: '#/$defs/actions' } }, required: ['actions'], additionalProperties: false,
  $defs: { actions: { type: 'array', minItems: 1, maxItems: 5, items: { $ref: '#/$defs/action' } },
    action: { oneOf: [branch('click'), branch(['check', 'uncheck'])], description: 'Disjoint operation branches' } },
});

test('referenced nonempty discriminator arrays keep references and all constraints', () => {
  const schema = fixture(), before = JSON.stringify(schema), result = projectToolInputSchema(schema);
  assert.notEqual(result, schema);
  assert.equal(JSON.stringify(schema), before);
  assert.equal(result.properties, schema.properties);
  assert.equal(result.$defs.actions, schema.$defs.actions);
  assert.deepEqual(result.$defs.action.anyOf, schema.$defs.action.oneOf);
  assert.equal(Object.hasOwn(result.$defs.action, 'oneOf'), false);
  assert.equal(result.$defs.action.description, 'Disjoint operation branches');
  assert.equal(projectToolInputSchema(result), result);
});

test('an independent JSON Schema validator accepts and rejects the same bounded sample space', () => {
  const schema = fixture(), ajv = new Ajv({ strict: false, allErrors: true });
  const before = ajv.compile(schema), after = ajv.compile(projectToolInputSchema(schema));
  const values = [null, true, 0, -1, 1.5, '', 'click', {}, [], { extra: true }];
  const entries = [...values];
  for (const action of [undefined, null, 'click', 'check', 'uncheck', 'other']) {
    for (const value of [undefined, -1, 0, 2, '2']) entries.push({ ...(action === undefined ? {} : { action }), ...(value === undefined ? {} : { value }) });
  }
  const cases = [...values, { actions: [] }, { actions: Array(6).fill({ action: 'click', value: 1 }) }];
  for (const entry of entries) {
    cases.push({ actions: [entry] }, { actions: [entry], extra: true }, { actions: [{ action: 'click', value: 0 }, entry] });
  }
  for (const value of cases) assert.equal(after(value), before(value), JSON.stringify(value));
  assert.equal(after({ actions: [{ action: 'click', value: 0 }, { action: 'uncheck', value: 1 }] }), true);
  assert.equal(after({ actions: [{ action: 'click', value: 0, extra: true }] }), false);
});

test('overlapping, optional, opaque and unresolved discriminator unions remain untouched', () => {
  const candidates = [
    { oneOf: [branch('same'), branch('same')] },
    { oneOf: [branch(['a', 'b']), branch(['b', 'c'])] },
    { oneOf: [branch('a'), { ...branch('b'), required: ['value'] }] },
    { oneOf: [branch('a'), branch('b', 'kind')] },
    { oneOf: [branch('a'), { $ref: '#/$defs/other' }] },
    { oneOf: [{ type: 'string' }, { type: 'number' }] },
    { oneOf: [branch('a'), branch('b')], anyOf: [{ type: 'object' }] },
    { oneOf: [branch({ nested: true }), branch({ nested: false })] },
    { oneOf: [{ ...branch('a'), properties: { action: { type: 'string' } } }, branch('b')] },
  ];
  for (const schema of candidates) assert.equal(projectToolInputSchema(schema), schema);
});

test('literal examples, default, const, enum and extension data are never rewritten', () => {
  const literal = { oneOf: [branch('a'), branch('b')] };
  const schema = { type: 'object', default: literal, examples: [literal], enum: [literal], const: literal,
    'x-example': literal, properties: { data: { type: 'string' } } };
  assert.equal(projectToolInputSchema(schema), schema);
});

test('nested schema positions are projected without treating property names as keywords', () => {
  const union = { oneOf: [branch('a'), branch('b')] };
  const schema = { type: 'object', properties: { oneOf: union }, items: union,
    allOf: [{ additionalProperties: union }], definitions: { nested: union } };
  const out = projectToolInputSchema(schema);
  assert.ok(out.properties.oneOf.anyOf);
  assert.ok(out.items.anyOf);
  assert.ok(out.allOf[0].additionalProperties.anyOf);
  assert.ok(out.definitions.nested.anyOf);
  assert.deepEqual(Object.keys(out.properties), ['oneOf']);
});

test('primitive discriminators distinguish types and safely retain special property names', () => {
  const schema = { oneOf: [branch('1', '__proto__'), branch(1, '__proto__'), branch(null, '__proto__'), branch(false, '__proto__')] };
  const out = projectToolInputSchema(schema);
  assert.equal(out.anyOf.length, 4);
  assert.equal(Object.hasOwn(out.anyOf[0].properties, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test('cycles and excessive nesting leave the whole input unchanged', () => {
  const cyclic = { properties: {} }; cyclic.properties.self = cyclic;
  assert.equal(projectToolInputSchema(cyclic), cyclic);
  const schema = fixture(); let node = schema;
  for (let i = 0; i < 70; i++) { node.properties ||= {}; node.properties.child = {}; node = node.properties.child; }
  assert.equal(projectToolInputSchema(schema), schema);
});

test('tools/list projection preserves cursor, metadata, output validation and tool identity', () => {
  const untouched = { name: 'simple', inputSchema: { type: 'object' } };
  const tool = { name: 'probe', inputSchema: fixture(), outputSchema: fixture(), annotations: { readOnlyHint: true } };
  const message = { jsonrpc: '2.0', id: 7, result: { tools: [untouched, tool], nextCursor: 'next', _meta: { sample: true } } };
  const out = projectMcpToolsList(message);
  assert.equal(out.result.tools[0], untouched);
  assert.equal(out.result.tools[1].outputSchema, tool.outputSchema);
  assert.equal(out.result.tools[1].annotations, tool.annotations);
  assert.equal(out.result.nextCursor, 'next');
  assert.equal(out.result._meta, message.result._meta);
  assert.equal(out.id, 7);
  for (const invalid of [null, {}, { error: { message: 'failed' } }, { result: { tools: [null, untouched] } }]) {
    assert.equal(projectMcpToolsList(invalid), invalid);
  }
});

test('referenced branches prove disjoint tags without expanding or mutating definitions', () => {
  const schema = { oneOf: [{ $ref: '#/$defs/launch~1mode' }, { $ref: '#/$defs/connect' }],
    $defs: { 'launch/mode': branch('launch', 'mode'), connect: branch('connect', 'mode') } };
  const before = JSON.stringify(schema), projected = projectToolInputSchema(schema);
  assert.deepEqual(projected.anyOf, schema.oneOf);
  assert.equal(projected.$defs, schema.$defs);
  assert.equal(JSON.stringify(schema), before);
  const ajv = new Ajv({ strict: false });
  const originalCheck = ajv.compile(schema), projectedCheck = ajv.compile(projected);
  for (const mode of ['launch', 'connect', 'other', null]) for (const value of [-1, 0, 1, '1']) {
    assert.equal(projectedCheck({ mode, value }), originalCheck({ mode, value }));
  }
});

test('reference proofs decline cycles, changed ID bases, unknown targets and overlapping aliases', () => {
  const cases = [
    { oneOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }], $defs: { a: { $ref: '#/$defs/a' }, b: branch('b') } },
    { oneOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/missing' }], $defs: { a: branch('a') } },
    { oneOf: [{ $ref: '#/$defs/a' }, { $ref: 'https://example.invalid/b' }], $defs: { a: branch('a') } },
    { oneOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }], $defs: { a: branch('same'), b: branch('same') } },
    { oneOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }], $defs: { a: { ...branch('a'), $id: 'elsewhere' }, b: branch('b') } },
    { properties: { nested: { $id: 'elsewhere', oneOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }] } },
      $defs: { a: branch('a'), b: branch('b') } },
  ];
  for (const schema of cases) assert.equal(projectToolInputSchema(schema), schema);
});

test('reference siblings never prove discriminator exclusivity across JSON Schema drafts', () => {
  for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
    const schema = { oneOf: ['a', 'b'].map(action => ({
      ...branch(action), properties: { ...branch(action).properties, action: { [keyword]: '#/definitions/tag', const: action } },
    })), definitions: { tag: { enum: ['shared'] } } };
    assert.equal(projectToolInputSchema(schema), schema, keyword);
    if (keyword === '$ref') {
      const validate = new Ajv({ strict: false, logger: false }).compile(schema);
      assert.equal(validate({ action: 'shared', value: 0 }), false, 'both original branches match');
    }
  }
  const scoped = { properties: { nested: { $id: 'https://example.invalid/other',
    oneOf: ['a', 'b'].map(action => ({ ...branch(action), $ref: '#/definitions/shared' })) } },
    definitions: { shared: { type: 'object' } } };
  assert.equal(projectToolInputSchema(scoped), scoped);
});

test('unknown and pre-const dialects are kept verbatim', () => {
  for (const $schema of ['http://json-schema.org/draft-04/schema#', 'https://example.invalid/schema']) {
    const schema = { $schema, ...fixture() };
    assert.equal(projectToolInputSchema(schema), schema);
  }
  for (const $schema of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
    assert.ok(projectToolInputSchema({ $schema, ...fixture() }).$defs.action.anyOf);
  }
});

test('embedded dialect resources are opaque, including when parent unions reference them', () => {
  const embedded = { $id: 'https://example.invalid/legacy', $schema: 'http://json-schema.org/draft-04/schema#',
    oneOf: [branch('a'), branch('b')] };
  const root = { $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { embedded } };
  assert.equal(projectToolInputSchema(root), root);
  const referenced = { oneOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }],
    $defs: { a: { $schema: 'http://json-schema.org/draft-04/schema#', ...branch('a') }, b: branch('b') } };
  assert.equal(projectToolInputSchema(referenced), referenced);
  const direct = { oneOf: [{ $schema: 'http://json-schema.org/draft-04/schema#', ...branch('a') }, branch('b')] };
  assert.equal(projectToolInputSchema(direct), direct);
  const propertyDialect = { oneOf: ['a', 'b'].map(action => ({
    ...branch(action), properties: { action: { $schema: 'http://json-schema.org/draft-04/schema#', const: action } },
  })) };
  assert.equal(projectToolInputSchema(propertyDialect), propertyDialect);
});

test('stdio server alwaysLoad survives SDK bridging through tool metadata without discarding metadata', () => {
  const tool = { name: 'fixture', inputSchema: { type: 'object' }, _meta: { custom: 'keep', 'anthropic/alwaysLoad': false } };
  const other = { name: 'plain', inputSchema: { type: 'object' } };
  const message = { id: 5, result: { tools: [tool, other] } };
  assert.equal(projectMcpToolsList(message), message);
  assert.equal(projectMcpToolsList(message, { alwaysLoad: false }), message);
  const result = projectMcpToolsList(message, { alwaysLoad: true });
  assert.deepEqual(result.result.tools[0]._meta, { custom: 'keep', 'anthropic/alwaysLoad': true });
  assert.equal(result.result.tools[0].inputSchema, tool.inputSchema);
  assert.equal(result.result.tools[1]._meta['anthropic/alwaysLoad'], true);
  assert.equal(tool._meta['anthropic/alwaysLoad'], false);
  assert.equal(projectMcpToolsList(result, { alwaysLoad: true }), result);
});
