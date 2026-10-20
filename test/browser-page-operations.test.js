'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { pageOperation } = require('../src/main/browser/browser-page-operations');
const { fixture } = require('./fixtures/browser-locator-tree.cjs');

function page() {
  const f = fixture(), location = { href: 'http://127.0.0.1/fixture' };
  const scope = { id: 'current', document: f.document, url: location.href, nodes: new Map() };
  const context = vm.createContext({ document: f.document, location, innerWidth: 1000, innerHeight: 800, getComputedStyle: node => node.style,
    __relayPlaywright: f.engine, __relayBrowserAutomation: scope });
  const run = input => vm.runInContext('(' + pageOperation.toString() + ')(' + JSON.stringify(input) + ')', context);
  const remember = node => { scope.nodes.set('e1', { element: node, role: node.role, name: node.name }); f.document.hit = node; };
  return { ...f, run, remember };
}

test('hidden and disabled controls remain readable for state assertions', () => {
  const f = page(), node = f.element('name', 'textbox', 'Name', { tag: 'input', hidden: true, disabled: true, value: 'Ada', attributes: { 'data-state': 'waiting' } });
  f.remember(node);
  const state = f.run({ operation: 'verify-element', observationId: 'current', ref: 'e1', attributeName: 'data-state' });
  assert.equal(state.visible, false); assert.equal(state.enabled, false); assert.equal(state.editable, false); assert.equal(state.value, 'Ada'); assert.equal(state.attribute, 'waiting');
  assert.equal(f.run({ operation: 'prepare', observationId: 'current', ref: 'e1' }).error.code, 'BROWSER_ELEMENT_HIDDEN');
});

test('transparent native checkbox stays observable and actionable when it receives pointer hits', () => {
  const f = page(), checkbox = f.element('native-checkbox', 'checkbox', 'Select row', { tag: 'input', type: 'checkbox' });
  checkbox.style.opacity = '0'; f.document.hit = checkbox;
  const observation = f.run({ operation: 'observe', observationId: 'transparent' });
  const description = observation.elements.find(element => element.name === 'Select row');
  assert.ok(description); assert.equal(description.visible, true); assert.equal(description.inViewport, true);
  const prepared = f.run({ operation: 'prepare', observationId: 'transparent', ref: description.ref });
  assert.equal(prepared.x, 35); assert.equal(prepared.y, 20);
});

test('transparent controls still fail hit testing when another node covers them', () => {
  const f = page(), checkbox = f.element('native-checkbox', 'checkbox', 'Select row', { tag: 'input', type: 'checkbox' });
  checkbox.style.opacity = '0'; f.remember(checkbox);
  f.document.hit = f.element('overlay', 'generic', '');
  assert.equal(f.run({ operation: 'prepare', observationId: 'current', ref: 'e1' }).error.code, 'BROWSER_ELEMENT_OBSCURED');
});

test('display none, hidden visibility, inert, and zero geometry remain non-actionable', () => {
  for (const condition of ['display', 'visibility', 'inert', 'geometry']) {
    const f = page(), checkbox = f.element('native-checkbox', 'checkbox', 'Select row', { tag: 'input', type: 'checkbox' }); f.remember(checkbox);
    if (condition === 'display') checkbox.style.display = 'none';
    if (condition === 'visibility') checkbox.style.visibility = 'hidden';
    if (condition === 'inert') checkbox.setAttribute('inert', '');
    if (condition === 'geometry') checkbox.getBoundingClientRect = () => ({ left: 10, right: 10, top: 10, bottom: 10, width: 0, height: 0 });
    assert.equal(f.run({ operation: 'prepare', observationId: 'current', ref: 'e1' }).error.code, 'BROWSER_ELEMENT_HIDDEN', condition);
  }
});

test('checkbox and option state are explicit; unrelated elements do not pass false assertions', () => {
  const f = page(), checkbox = f.element('agree', 'checkbox', 'Agree', { tag: 'input', type: 'checkbox', checked: false });
  f.remember(checkbox);
  assert.equal(f.run({ operation: 'verify-element', observationId: 'current', ref: 'e1' }).checked, false);
  checkbox.indeterminate = true;
  assert.equal(f.run({ operation: 'query-state', locator: { css: '#agree' }, wantChecked: true }).checked, 'mixed');
  const button = f.element('save', 'button', 'Save'); f.remember(button);
  const state = f.run({ operation: 'verify-element', observationId: 'current', ref: 'e1' });
  assert.equal(state.checked, undefined); assert.equal(state.selected, undefined);
  const tab = f.element('tab', 'tab', 'Settings', { attributes: { 'aria-selected': 'true' } }); f.remember(tab);
  assert.equal(f.run({ operation: 'verify-element', observationId: 'current', ref: 'e1' }).selected, true);
});

test('count permits several matches but individual state and attributes require uniqueness', () => {
  const f = page(); f.element('a', 'button', 'Save'); f.element('b', 'button', 'Save');
  assert.equal(f.run({ operation: 'query-state', locator: { role: 'button' } }).count, 2);
  for (const field of ['wantUnique', 'wantChecked', 'wantSelected', 'wantEditable', 'wantEnabled', 'wantValue', 'wantText']) assert.equal(f.run({ operation: 'query-state', locator: { role: 'button' }, [field]: true }).error.code, 'BROWSER_LOCATOR_AMBIGUOUS');
  assert.equal(f.run({ operation: 'query-state', locator: { role: 'button' }, attributeName: 'title' }).error.code, 'BROWSER_LOCATOR_AMBIGUOUS');
  assert.equal(f.run({ operation: 'query-state', locator: { role: 'textbox' } }).count, 0);
  assert.equal(f.run({ operation: 'query-state', locator: { role: 'textbox' }, wantUnique: true }).attached, false);
});

test('valid Unicode HTML attributes are readable and malformed names are rejected', () => {
  const f = page(), node = f.element('status', 'status', 'Status', { attributes: { 'data-状态': '完成' } }); f.remember(node);
  assert.equal(f.run({ operation: 'verify-element', observationId: 'current', ref: 'e1', attributeName: 'data-状态' }).attribute, '完成');
  for (const attributeName of ['bad name', 'bad=name', 'bad/name', 'bad\u0000name']) assert.equal(f.run({ operation: 'verify-element', observationId: 'current', ref: 'e1', attributeName }).error.code, 'BROWSER_INVALID_ATTRIBUTE');
});

test('password value and value attribute remain blocked in both assertion paths', () => {
  const f = page(), node = f.element('password', 'textbox', 'Password', { tag: 'input', type: 'password', value: 'must-not-return', attributes: { value: 'must-not-return' } }); f.remember(node);
  for (const request of [{ operation: 'query-state', locator: { css: '#password' }, wantValue: true }, { operation: 'query-state', locator: { css: '#password' }, attributeName: 'value' },
    { operation: 'verify-element', observationId: 'current', ref: 'e1', value: 'must-not-return' }, { operation: 'verify-element', observationId: 'current', ref: 'e1', attributeName: 'value' }]) {
    const result = f.run(request); assert.equal(result.error.code, 'BROWSER_PASSWORD_READ_BLOCKED'); assert.ok(!JSON.stringify(result).includes('must-not-return'));
  }
  assert.equal(f.run({ operation: 'verify-element', observationId: 'current', ref: 'e1' }).value, undefined);
});

test('stable preflight rechecks identity after the asynchronous geometry wait', async () => {
  const f = page(), node = f.element('save', 'button', 'Save'); f.remember(node);
  f.engine.checkElementStates = async () => { node.isConnected = false; };
  assert.equal((await f.run({ operation: 'prepare-stable', observationId: 'current', ref: 'e1' })).error.code, 'BROWSER_ELEMENT_STALE');
  node.isConnected = true; f.engine.checkElementStates = async () => ({ missingState: 'stable' });
  assert.equal((await f.run({ operation: 'prepare-stable', observationId: 'current', ref: 'e1' })).error.code, 'BROWSER_ELEMENT_UNSTABLE');
  f.engine.checkElementStates = async () => undefined;
  assert.equal((await f.run({ operation: 'prepare-stable', observationId: 'current', ref: 'e1' })).x, 35);
});

test('serialized page operation composes locators without require or external closures', () => {
  const f = page(), row = f.element('row', 'row', 'Order ready'); f.element('save', 'button', 'Save', {}, row);
  const result = f.run({ operation: 'resolve-locator', observationId: 'current', locator: { role: 'row', hasText: 'ready', chain: [{ role: 'button', name: 'Save' }] } });
  assert.equal(result.name, 'Save'); assert.ok(result.ref);
});

const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children)]);

test('list observations remain the default and tree containers omit generic layout noise', () => {
  const f = page(), region = f.element('region', 'region', 'Orders'), layout = f.element('layout', 'generic', '', {}, region);
  f.element('save', 'button', 'Save', { tag: 'button' }, layout);
  const list = f.run({ operation: 'observe', observationId: 'list', limit: 1 });
  assert.equal(list.tree, undefined); assert.equal(list.elements[0].name, 'Save');
  const result = f.run({ operation: 'observe', observationId: 'tree', format: 'tree', limit: 1 });
  assert.equal(result.tree[0].role, 'region'); assert.equal(result.tree[0].children[0].role, 'button');
  assert.ok(!flatten(result.tree).some(node => node.role === 'generic'));
  assert.equal(result.tree[0].children[0].ref, result.elements[0].ref);
  assert.equal(result.treeInfo.kind, 'dom-semantic-tree');
});

test('tree pagination contains only this page of action references and its ancestors', () => {
  const f = page(), grid = f.element('grid', 'grid', 'Orders'), a = f.element('a', 'row', 'First', {}, grid), b = f.element('b', 'row', 'Second', {}, grid);
  f.element('first', 'button', 'First action', { tag: 'button' }, a); f.element('second', 'button', 'Second action', { tag: 'button' }, b);
  const result = f.run({ operation: 'observe', observationId: 'page2', format: 'tree', offset: 1, limit: 1 });
  const nodes = flatten(result.tree);
  assert.equal(result.treeInfo.paginated, true);
  assert.deepEqual(Array.from(nodes.filter(node => node.ref), node => node.name), ['Second action']);
  assert.ok(!nodes.some(node => node.name === 'First'));
  assert.equal(result.tree[0].role, 'grid');
});

test('explicit scope constrains the tree and preserves useful selected/expanded state', () => {
  const f = page(), group = f.element('group', 'group', 'Sections'), tab = f.element('tab', 'tab', 'Settings', { attributes: { 'aria-selected': 'true', 'aria-expanded': 'false' } }, group);
  f.element('outside', 'button', 'Outside');
  const result = f.run({ operation: 'observe', observationId: 'scope', format: 'tree', scope: { css: '#group' } });
  const node = flatten(result.tree).find(node => node.name === 'Settings');
  assert.equal(node.selected, true); assert.equal(node.expanded, false);
  assert.ok(!flatten(result.tree).some(node => node.name === 'Outside'));
});

test('deep semantic trees are explicitly truncated without exceeding the depth budget', () => {
  const f = page(); let parent = f.document;
  for (let index = 0; index < 30; index++) parent = f.element('g' + index, 'group', 'Level ' + index, {}, parent);
  f.element('deep', 'button', 'Deep action', { tag: 'button' }, parent);
  const result = f.run({ operation: 'observe', observationId: 'deep', format: 'tree', limit: 1 });
  const depth = nodes => nodes.length ? 1 + Math.max(...nodes.map(node => depth(node.children))) : 0;
  assert.equal(result.treeInfo.truncated, true); assert.ok(depth(result.tree) <= 24);
  assert.equal(result.elements.length, 1);
});

test('wide semantic trees stop at the node budget and retain the flat page as fallback', () => {
  const f = page();
  for (let index = 0; index < 350; index++) {
    const group = f.element('g' + index, 'group', 'Group ' + index), row = f.element('r' + index, 'row', 'Row ' + index, {}, group);
    f.element('b' + index, 'button', 'Action ' + index, { tag: 'button' }, row);
  }
  const result = f.run({ operation: 'observe', observationId: 'wide', format: 'tree', limit: 350 });
  assert.equal(result.treeInfo.truncated, true); assert.ok(result.treeInfo.nodeCount <= 1000); assert.ok(flatten(result.tree).length <= 1000);
  assert.equal(result.elements.length, 350);
});

test('tree does not expand iframe documents or claim to be a complete ARIA snapshot', () => {
  const f = page(), frame = f.element('frame', 'generic', '', { tag: 'iframe' });
  frame.contentDocument = { querySelectorAll() { throw Error('Must not enter another frame'); } };
  f.element('save', 'button', 'Save', { tag: 'button' });
  const result = f.run({ operation: 'observe', observationId: 'frame', format: 'tree', limit: 1 });
  assert.equal(result.treeInfo.kind, 'dom-semantic-tree'); assert.equal(result.frames.length, 1);
  assert.equal(flatten(result.tree).length, 1);
});

test('tree levels are finite bounded integers and hostile string fields cannot expand the tree payload', () => {
  const f = page(), node = f.element('item', 'treeitem', 'N'.repeat(1000000), { attributes: { 'aria-level': 'X'.repeat(1000000), 'data-extra': 'A'.repeat(1000000) } });
  const observe = () => f.run({ operation: 'observe', observationId: 'bounded', format: 'tree', attributeName: 'data-extra' });
  let result = observe(), entry = flatten(result.tree)[0];
  assert.equal(entry.level, undefined); assert.equal(entry.name.length, 300); assert.equal(entry.attribute, undefined);
  assert.ok(JSON.stringify(result.tree).length < 1000);
  for (const rawLevel of ['0', '-1', 'Infinity', 'NaN', '1.5', '10001', '00001']) {
    node.setAttribute('aria-level', rawLevel); assert.equal(flatten(observe().tree)[0].level, undefined, rawLevel);
  }
  for (const rawLevel of ['1', '24', '10000']) {
    node.setAttribute('aria-level', rawLevel); assert.equal(flatten(observe().tree)[0].level, Number(rawLevel));
  }
  node.tagName = 'X'.repeat(1000000); node.role = 'R'.repeat(1000000);
  entry = flatten(observe().tree)[0];
  assert.equal(entry.tag.length, 100); assert.equal(entry.role.length, 100); assert.ok(JSON.stringify(entry).length < 1000);
});
