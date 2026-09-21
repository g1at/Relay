'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAgents, selectionState } = require('../renderer/agent-picker');

test('installed Agent identities are deduplicated without mutating source data', () => {
  const original = [{ name: 'review', displayName: '审查', desc: '检查结果' }, { name: 'review' }, null, { name: '' }, { name: 12 }, { name: 'write', description: '写作' }];
  const before = JSON.stringify(original);
  const agents = normalizeAgents({ items: original });
  assert.deepEqual(agents.map(a => a.name), ['review', 'write']);
  assert.equal(agents[0].description, '检查结果');
  assert.equal(agents[1].displayName, 'write');
  assert.equal(agents[1].description, '写作');
  assert.equal(JSON.stringify(original), before);
  for (const invalid of [null, {}, false, { items: {} }]) assert.deepEqual(normalizeAgents(invalid), []);
});

test('zero selection cannot implicitly dispatch all installed Agents', () => {
  const agents = normalizeAgents([{ name: 'a' }, { name: 'b' }]);
  for (const selected of [new Set(), new Set(['deleted'])]) {
    assert.equal(selectionState(agents, selected).mode, null);
    assert.deepEqual(selectionState(agents, selected).items, []);
  }
});

test('single and multiple selection choose Agent or collaboration with exact identities', () => {
  const agents = normalizeAgents([{ name: 'a', displayName: 'A' }, { name: 'b' }, { name: 'c' }]);
  const selected = new Set(['b']);
  assert.equal(selectionState(agents, selected).mode, 'agent');
  assert.equal(selectionState(agents, selected).items[0].name, 'b');
  selected.add('a');
  const multi = selectionState(agents, selected);
  assert.equal(multi.mode, 'orchestrate');
  assert.deepEqual(multi.items.map(a => a.name), ['a', 'b']);
  assert.equal(multi.label, '开始协奏 · 2');
  selected.delete('b');
  assert.equal(selectionState(agents, selected).mode, 'agent');
  assert.match(selectionState(agents, selected).hint, /A/);
});
