'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { MODES, permissionState, placePopover } = require('../renderer/permission-controls');

test('only the three exact permission values are selectable; unknown is never promoted', () => {
  assert.deepEqual(MODES.map(mode => mode.value), ['default', 'acceptEdits', 'bypassPermissions']);
  for (const value of [undefined, null, {}, 'plan', 'constructor', '__proto__', 'DEFAULT']) {
    const state = permissionState({ permissionMode: value });
    assert.equal(state.disabled, true); assert.equal(state.mode, null);
  }
  for (const mode of MODES) assert.equal(permissionState({ permissionMode: mode.value }).disabled, false);
  assert.equal(permissionState(null).disabled, true);
});
test('plan preserves the underlying permission label and blocks changes', () => {
  const state = permissionState({ permissionMode: 'acceptEdits', plan: true });
  assert.equal(state.label, '帮我批准'); assert.equal(state.disabled, true); assert.match(state.title, /计划模式/);
  assert.equal(permissionState({ permissionMode: 'acceptEdits', plan: false }).disabled, false);
});
test('busy describes a pending change, and disabled is independent of the saved permission', () => {
  const busy = permissionState({ permissionMode: 'default', busy: true });
  assert.equal(busy.disabled, true); assert.equal(busy.title, '正在更新权限…'); assert.equal(busy.label, '请求批准');
  assert.equal(permissionState({ permissionMode: 'bypassPermissions', disabled: true }).mode.value, 'bypassPermissions');
});
test('popover prefers space above and flips below when the anchor is near the top', () => {
  const above = placePopover({ left: 400, top: 600, bottom: 627 }, { width: 360, height: 205 }, { width: 1200, height: 800 });
  assert.equal(above.side, 'above'); assert.equal(above.top + 205 + 8, 600);
  const below = placePopover({ left: 400, top: 24, bottom: 51 }, { width: 360, height: 205 }, { width: 1200, height: 800 });
  assert.equal(below.side, 'below'); assert.equal(below.top, 59);
});
test('narrow/short viewports clamp width and height while respecting viewport offsets', () => {
  for (const viewport of [{ width: 280, height: 220 }, { left: 50, top: 30, width: 280, height: 220 }]) {
    const result = placePopover({ left: 260, top: 180, bottom: 207 }, { width: 360, height: 230 }, viewport);
    assert.equal(result.width, 260); assert.ok(result.left >= (viewport.left || 0) + 10);
    assert.ok(result.left + result.width <= (viewport.left || 0) + viewport.width - 10);
    assert.ok(result.top >= (viewport.top || 0) + 10); assert.ok(result.top + result.maxHeight <= (viewport.top || 0) + viewport.height - 10);
  }
});
test('main composer loads the shared control and places a disabled permission trigger directly after plus', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.match(html, /href="permission-controls\.css"/); assert.match(html, /src="permission-controls\.js"/);
  assert.match(html, /id="btnAttach"[\s\S]*?<\/button>\s*<button id="btnPermissionMode"[^>]*disabled/);
});
