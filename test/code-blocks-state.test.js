'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { snapshot } = require('../renderer/code-blocks');
test('stream snapshots skip unchanged offscreen code metrics and preserve replacement indices', () => {
  const untouched = { querySelector() { throw Error('untouched code must not force layout'); } };
  const replacement = { querySelector: () => ({ textContent: 'growing code', scrollLeft: 42, scrollTop: 80 }),
    classList: { contains: () => true }, dataset: { codeToggled: 'true' } };
  const states = snapshot({ querySelectorAll: () => [untouched, replacement] }, { include: pre => pre === replacement });
  assert.deepEqual(states, [null, { text: 'growing code', collapsed: true, toggled: true, scrollLeft: 42, scrollTop: 80 }]);
});
