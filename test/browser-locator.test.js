'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createLocatorRuntime, validateLocator, createLocatorSchema } = require('../src/main/browser/browser-locator');
const { fixture } = require('./fixtures/browser-locator-tree.cjs');

function rows() {
  const f = fixture();
  const first = f.element('r1', 'row', 'Order A pending');
  f.element('b1', 'button', 'Approve', {}, first);
  f.element('s1', 'status', 'Pending', {}, first);
  const second = f.element('r2', 'row', 'Order B ready');
  f.element('b2', 'button', 'Approve', {}, second);
  f.element('s2', 'status', 'Ready', {}, second);
  f.element('b3', 'button', 'Cancel', { hidden: true }, second);
  f.element('outside', 'button', 'Approve');
  const runtime = createLocatorRuntime(f.environment);
  return { ...f, find: input => runtime.find(input).map(node => node.id) };
}

test('within and chain keep has/hasNot scoped to descendants', () => {
  const f = rows();
  assert.deepEqual(f.find({ role: 'button', name: 'Approve', within: { role: 'row', has: { role: 'status', text: 'Ready' } } }), ['b2']);
  assert.deepEqual(f.find({ role: 'row', hasNot: { role: 'status', text: 'Ready' }, chain: [{ role: 'button', name: 'Approve' }] }), ['b1']);
  assert.deepEqual(f.find({ role: 'row', has: { role: 'row' } }), []);
});

test('union/intersection are deduplicated in DOM order before per-step nth', () => {
  const f = rows();
  assert.deepEqual(f.find({ role: 'button', name: 'Approve', and: [{ css: '#b2' }], or: [{ css: '#b1' }, { css: '#b2' }] }), ['b1', 'b2']);
  assert.deepEqual(f.find({ role: 'button', name: 'Approve', or: [{ css: '#b1' }], nth: 1 }), ['b2']);
  assert.deepEqual(f.find({ role: 'row', nth: 1, chain: [{ role: 'button', visible: true, nth: 0 }] }), ['b2']);
});

test('substring filters normalize whitespace and remain distinct from exact atom text', () => {
  const f = rows();
  assert.deepEqual(f.find({ role: 'row', hasText: '  ORDER   b ', hasNotText: 'pending' }), ['r2']);
  assert.deepEqual(f.find({ role: 'button', text: 'approv', exact: false, within: { role: 'row', hasText: 'ready' } }), ['b2']);
  assert.deepEqual(f.find({ role: 'button', name: 'Cancel', visible: false }), ['b3']);
});

test('overlapping containers do not duplicate descendants and cannot include another document', () => {
  const f = fixture(), outer = f.element('outer', 'group'), inner = f.element('inner', 'group', '', {}, outer);
  f.element('button', 'button', 'Save', {}, inner);
  const foreign = f.element('foreign', 'button', 'Save'); foreign.ownerDocument = {};
  assert.deepEqual(createLocatorRuntime(f.environment).find({ role: 'button', within: { role: 'group' } }).map(node => node.id), ['button']);
});

test('CSS selectors cannot inject another selector engine or a frame transition', () => {
  const f = rows();
  for (const css of ['iframe >> internal:control=enter-frame >> css=button', '* >> internal:role=button']) assert.throws(() => f.find({ css }), { code: 'BROWSER_INVALID_LOCATOR' });
});

test('bounded nonrecursive contract rejects unsupported nesting, code, bad types, and excessive work', () => {
  for (const value of [{}, { role: 'button', script: 'alert(1)' }, { role: 'button', has: { role: 'row', has: { role: 'button' } } },
    { role: 'button', within: { role: 'row', chain: [{ role: 'button' }] } }, { role: 'button', chain: Array(7).fill({ role: 'row' }) },
    { role: 'button', and: [] }, { role: 'button', exact: 'false' }, { role: 'button', nth: -1 }, { role: 'button', hasText: /x/ }]) assert.throws(() => validateLocator(value));
  const cycle = { role: 'button' }; cycle.has = cycle; assert.throws(() => validateLocator(cycle));
  const crowded = { role: 'button', chain: Array.from({ length: 6 }, () => ({ role: 'row', and: Array(6).fill({ role: 'button' }), or: Array(6).fill({ role: 'button' }) })) };
  assert.throws(() => validateLocator(crowded), /64/);
});

test('serialized runtime has no host dependencies and preserves the same validation', () => {
  const create = vm.runInNewContext('(' + createLocatorRuntime.toString() + ')');
  assert.equal(create().validate({ role: 'button', has: { text: 'Ready' } }).role, 'button');
  assert.throws(() => create().validate({ role: 'button', chain: Array(7).fill({ text: 'x' }) }));
});

test('zod schema and runtime share the same shape and condition budget', () => {
  const { z } = require('zod'), schema = createLocatorSchema(z);
  const valid = { role: 'button', within: { role: 'row', hasText: 'Ready' }, or: [{ text: 'Save' }], chain: [{ css: 'span', visible: true }] };
  assert.deepEqual(schema.parse(valid), valid);
  assert.equal(schema.safeParse({ role: 'button', within: { role: 'row', within: { role: 'group' } } }).success, false);
  assert.equal(schema.safeParse({ name: '' }).success, false);
});
