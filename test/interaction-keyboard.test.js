'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'interaction-surface.js'), 'utf8');
const start = source.indexOf('  function onShellKeydown(');
const end = source.indexOf('  function focusDecision(', start);

function fixture(kind = 'permission') {
  const decisions = [], moves = [];
  const interaction = { id: 'synthetic-decision', kind };
  const state = { items: new Map([[interaction.id, interaction]]), currentId: interaction.id, busyIds: new Set() };
  const mount = { hidden: false };
  let menuOpen = false;
  const context = vm.createContext({ state, mount, closePermissionMenu: () => { const wasOpen = menuOpen; menuOpen = false; return wasOpen; },
    isVisibleInteraction: () => true, isInteractionBusy: () => state.busyIds.has(state.currentId), respond: (item, decision) => decisions.push({ id: item.id, ...decision }),
    moveSelection: delta => moves.push(delta) });
  vm.runInContext(source.slice(start, end), context);
  return { state, mount, decisions, moves, openMenu: () => { menuOpen = true; }, close: () => context.dismissCurrent(),
    key(key, overrides = {}) {
      const event = { key, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
        target: { closest: () => null }, ...overrides };
      context.onShellKeydown(event); return event;
    } };
}

test('Escape denies only the visible permission and does not stop the task or approve it', () => {
  const f = fixture();
  const event = f.key('Escape');
  assert.equal(f.decisions.length, 1);
  assert.equal(f.decisions[0].action, 'deny');
  assert.equal(f.decisions[0].interrupt, undefined);
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
});

test('question close and Escape explicitly skip the whole request without submitting partial answers', () => {
  for (const trigger of ['close', 'escape']) {
    const f = fixture('question');
    if (trigger === 'close') f.close(); else f.key('Escape');
    assert.equal(f.decisions.length, 1);
    assert.equal(f.decisions[0].action, 'deny');
    assert.equal(f.decisions[0].answers, undefined);
    assert.match(f.decisions[0].message, /跳过.*未提交答案/);
  }
});

test('Enter from the permission title allows exactly once, never for the session', () => {
  const f = fixture();
  const event = f.key('Enter');
  assert.equal(f.decisions.length, 1);
  assert.equal(f.decisions[0].action, 'allow_once');
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
});

test('IME composition and held keys never submit or dismiss a decision', () => {
  for (const key of ['Enter', 'Escape']) {
    for (const guard of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }]) {
      const f = fixture(); f.key(key, guard);
      assert.equal(f.decisions.length, 0, `${key} ${JSON.stringify(guard)}`);
    }
  }
});

test('Enter on controls or editable content cannot override their explicit native action', () => {
  for (const control of ['deny button', 'session button', 'details summary', 'textarea', 'contenteditable']) {
    const f = fixture();
    const event = f.key('Enter', { target: { closest: () => ({ control }) } });
    assert.equal(f.decisions.length, 0, control);
    assert.equal(event.prevented, undefined, control);
  }
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    const f = fixture(); f.key('Enter', { [modifier]: true });
    assert.equal(f.decisions.length, 0, modifier);
  }
  const question = fixture('question'); question.key('Enter');
  assert.equal(question.decisions.length, 0, 'question answers still go through form validation');
});

test('busy or resolved requests cannot receive a second keyboard decision', () => {
  const busy = fixture(); busy.state.busyIds.add(busy.state.currentId);
  busy.key('Enter'); busy.key('Escape'); busy.close();
  assert.equal(busy.decisions.length, 0);
  const resolved = fixture(); resolved.state.items.clear();
  resolved.key('Enter'); resolved.key('Escape'); resolved.close();
  assert.equal(resolved.decisions.length, 0);
});

test('Alt-arrow request navigation remains separate from permission decisions', () => {
  const f = fixture();
  f.key('ArrowLeft', { altKey: true }); f.key('ArrowRight', { altKey: true });
  assert.deepEqual(f.moves, [-1, 1]); assert.equal(f.decisions.length, 0);
});

test('hidden decision titles cannot approve and Escape first closes an open scope menu', () => {
  const f = fixture(); f.mount.hidden = true;
  f.key('Enter'); f.key('Escape'); assert.equal(f.decisions.length, 0);
  f.mount.hidden = false; f.openMenu();
  const event = f.key('Escape'); assert.equal(event.prevented, true); assert.equal(f.decisions.length, 0);
  f.key('Escape'); assert.equal(f.decisions.length, 1); assert.equal(f.decisions[0].action, 'deny');
});
