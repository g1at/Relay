'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { InteractionBroker } = require('../src/main/tasks/interaction-broker');
const { normalizeElicitationSchema, validateElicitationContent, normalizeElicitationUrl } = require('../src/main/tasks/elicitation-schema');

const context = { runId: 'run-A', conversationId: 'A', windowId: 7 };
const request = schema => ({ serverName: 'fixture-mcp', message: '填写测试参数', requestedSchema: schema });
const minimal = { type: 'object', properties: { name: { type: 'string', minLength: 2 } }, required: ['name'] };
function fixture(t, overrides = {}) {
  const events = []; let nextId = 0;
  const broker = new InteractionBroker({ idFactory: () => `elicitation-${++nextId}`, onChange: event => events.push(event), ...overrides });
  t.after(() => broker.close());
  const start = (extra = {}) => broker.registerElicitation({ request: request(minimal),
    context, sdkOptions: { requestId: 'request-1', signal: new AbortController().signal }, ...extra });
  return { broker, events, start };
}

test('all MCP primitive and enum variants retain types and enforce values', () => {
  const schema = normalizeElicitationSchema({ type: 'object', properties: {
    name: { type: 'string', minLength: 2, maxLength: 4 }, count: { type: 'integer', minimum: 1, maximum: 5 },
    ratio: { type: 'number', minimum: 0 }, yes: { type: 'boolean', default: false },
    mode: { type: 'string', oneOf: [{ const: 'fast', title: '快速' }, { const: '', title: '空字符串' }] },
    legacy: { type: 'string', enum: ['a', 'b'], enumNames: ['甲', '乙'] },
    plain: { type: 'string', enum: ['c'] },
    many: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['x', 'y'] } },
    titled: { type: 'array', items: { anyOf: [{ const: 'a', title: '甲' }] } },
  }, required: ['name', 'count', 'yes'] });
  const content = { name: '测试', count: 2, ratio: .5, yes: false, mode: '', legacy: 'a', plain: 'c', many: ['x'], titled: ['a'] };
  assert.deepEqual(validateElicitationContent(schema, content), content);
  for (const invalid of [{ ...content, count: 1.5 }, { ...content, count: 6 }, { ...content, yes: 'false' },
    { ...content, ratio: NaN }, { ...content, mode: 'other' }, { ...content, many: [] },
    { ...content, many: ['x', 'x'] }, { ...content, name: 'a' }, { ...content, extra: 'forged' }]) {
    assert.throws(() => validateElicitationContent(schema, invalid));
  }
  assert.throws(() => validateElicitationContent(schema, { name: '测试', count: 1 }));
});

test('unknown constraints and unsafe keys are rejected instead of silently weakened', () => {
  for (const schema of [
    { ...minimal, allOf: [] }, { ...minimal, properties: { name: { type: 'object', properties: {} } } },
    { ...minimal, properties: { name: { type: 'string', pattern: '^only$' } } },
    { ...minimal, properties: { name: { type: 'string', default: 'x', minLength: 4 } } },
    { ...minimal, required: ['missing'] }, JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
  ]) assert.throws(() => normalizeElicitationSchema(schema));
  assert.throws(() => validateElicitationContent(normalizeElicitationSchema(minimal), JSON.parse('{"name":"ok","__proto__":{}}')));
});

test('formats validate real calendar dates and strings, without network requests', () => {
  for (const [format, accepted, rejected] of [['email', 'a@b.test', 'a'], ['uri', 'https://fixture.invalid/x', '/relative'],
    ['date', '2024-02-29', '2025-02-29'], ['date-time', '2026-09-11T08:00:00+08:00', '2026-09-11T08:00:00']]) {
    const schema = normalizeElicitationSchema({ type: 'object', properties: { value: { type: 'string', format } } });
    assert.equal(validateElicitationContent(schema, { value: accepted }).value, accepted);
    assert.throws(() => validateElicitationContent(schema, { value: rejected }));
  }
  assert.equal(validateElicitationContent(normalizeElicitationSchema({ type: 'object', properties: { value: { type: 'string', maxLength: 1 } } }), { value: '😀' }).value, '😀');
});

test('form callback is isolated, typed and redelivery-idempotent', async t => {
  const { broker, events, start } = fixture(t);
  const pending = start();
  assert.equal(start(), pending);
  const dto = broker.list({ conversationId: 'A' })[0];
  assert.equal(dto.kind, 'elicitation');
  assert.equal(dto.requestId, undefined);
  assert.equal(dto.elicitation.schema.fields[0].name, 'name');
  assert.equal(broker.list({ conversationId: 'B' }).length, 0);
  const other = start({ context: { ...context, runId: 'run-B', conversationId: 'B' } });
  assert.equal(broker.size, 2);
  assert.throws(() => broker.respond(dto.id, { action: 'accept', content: { name: 'x' } }), /至少输入/);
  assert.equal(broker.size, 2);
  broker.respond(dto.id, { action: 'accept', content: { name: '合法' } });
  assert.deepEqual(await pending, { action: 'accept', content: { name: '合法' } });
  assert.deepEqual(await start(), { action: 'accept', content: { name: '合法' } });
  assert.equal(events.filter(event => event.type === 'interaction.resolved').length, 1);
  assert.equal(JSON.stringify(events).includes('合法'), false, 'answers never enter event/history DTOs');
  broker.rejectTask('run-B');
  assert.deepEqual(await other, { action: 'cancel' });
});

test('unsupported forms are visible but cannot accept and bypass mode cannot answer forms', async t => {
  const { broker, start } = fixture(t);
  const pending = start({ request: request({ ...minimal, properties: { name: { type: 'string', pattern: '^yes$' } } }) });
  const dto = broker.list()[0];
  assert.match(dto.elicitation.unsupported, /pattern/);
  assert.throws(() => broker.respond(dto.id, { action: 'accept', content: { name: 'yes' } }), /pattern/);
  assert.equal(broker.reconcilePermissionMode({ ...context, permissionMode: 'bypassPermissions' }), 0);
  assert.equal(broker.size, 1);
  broker.respond(dto.id, { action: 'decline' });
  assert.deepEqual(await pending, { action: 'decline' });
});

test('abort, timeout, shutdown and scope-less calls cancel without approvals', async t => {
  const callbacks = [];
  const { broker, events, start } = fixture(t, { setTimeout: callback => { callbacks.push(callback); return 1; }, clearTimeout() {} });
  const controller = new AbortController();
  const pending = start({ sdkOptions: { requestId: 'aborted', signal: controller.signal } });
  controller.abort(); callbacks.shift()();
  assert.deepEqual(await pending, { action: 'cancel' });
  assert.equal(events.filter(event => event.type === 'interaction.resolved').length, 1);
  const timeout = start(); callbacks.shift()(); assert.deepEqual(await timeout, { action: 'cancel' });
  const closed = start({ sdkOptions: { requestId: 'closed' } }); broker.rejectWindow(7); assert.deepEqual(await closed, { action: 'cancel' });
  assert.deepEqual(await start({ context: {} }), { action: 'cancel' });
  assert.deepEqual(await start({ context: { ...context, background: true } }), { action: 'cancel' });
});

test('URL mode only permits safe browser schemes and requires user action', async t => {
  const { broker, start } = fixture(t);
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'http://remote.test/auth', 'https://user:pw@remote.test', 'https://x.test/\nq']) {
    assert.throws(() => normalizeElicitationUrl(url));
  }
  assert.equal(normalizeElicitationUrl('http://localhost:8800/auth'), 'http://localhost:8800/auth');
  const pending = start({ request: { serverName: 'fixture-mcp', message: '打开网页', mode: 'url',
    url: 'https://fixture.invalid/auth', elicitationId: 'url-1' } });
  const dto = broker.list()[0];
  assert.equal(broker.urlElicitations.size, 0);
  broker.respond(dto.id, { action: 'accept', content: { forged: 'ignored' } });
  assert.deepEqual(await pending, { action: 'accept' });
  assert.equal(broker.urlElicitations.size, 1);
  const complete = { type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'fixture-mcp', elicitation_id: 'url-1' };
  assert.equal(broker.completeElicitation(complete, { ...context, conversationId: 'B' }), false);
  assert.equal(broker.completeElicitation(complete, { ...context, runId: 'later-run' }), false);
  assert.equal(broker.completeElicitation(complete, context), true);
  assert.equal(broker.completeElicitation(complete, context), false);
});

test('completion racing browser launch is remembered without auto-accepting', async t => {
  const { broker, events, start } = fixture(t);
  const pending = start({ request: { serverName: 'fixture-mcp', message: '网页', mode: 'url', url: 'https://fixture.invalid', elicitationId: 'url-early' } });
  assert.equal(broker.completeElicitation({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'fixture-mcp', elicitation_id: 'url-early' }, context), true);
  assert.equal(broker.size, 1);
  broker.respond(broker.list()[0].id, { action: 'accept' });
  assert.deepEqual(await pending, { action: 'accept' });
  assert.equal(broker.urlElicitations.size, 0);
  assert.equal(events.filter(event => event.type === 'interaction.elicitation_complete').length, 1);
});
