'use strict';

const namedKeys = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }, PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }, Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};
function invalid(message) { return Object.assign(new Error(message), { code: 'BROWSER_KEY_UNSUPPORTED' }); }
function modifiers(values = []) {
  if (!Array.isArray(values) || values.length > 4) throw invalid('修饰键列表无效');
  const map = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8, ControlOrMeta: process.platform === 'darwin' ? 4 : 2 };
  return values.reduce((mask, value) => { if (!Object.hasOwn(map, value)) throw invalid('未知修饰键'); return mask | map[value]; }, 0);
}
function parseKey(value) {
  if (typeof value !== 'string' || value.length > 100) throw invalid('按键无效');
  const parts = value.split('+'), name = parts.pop();
  const mask = modifiers(parts);
  let key = Object.hasOwn(namedKeys, name) ? namedKeys[name] : null;
  if (!key && /^[a-z0-9]$/i.test(name)) key = { key: name, code: /^[a-z]$/i.test(name) ? 'Key' + name.toUpperCase() : 'Digit' + name, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), text: name };
  if (!key && /^F(?:[1-9]|1[0-2])$/.test(name)) key = { key: name, code: name, windowsVirtualKeyCode: 111 + Number(name.slice(1)) };
  if (!key) throw invalid('暂不支持此按键');
  key = { ...key, modifiers: mask };
  if (mask & 7) delete key.text;
  if (mask & 8 && /^[a-z]$/.test(key.key)) { key.key = key.key.toUpperCase(); if (key.text) key.text = key.key; }
  return key;
}
// Executed on the frame owner in its parent's isolated world. Never accepts code
// from the caller. The hit test makes parent overlays part of input actionability.
function frameOwnerPoint(point, viewport) {
  const fail = (code, message) => ({ error: { code, message } });
  if (!this.isConnected) return fail('BROWSER_FRAME_UNAVAILABLE', '框架已脱离页面');
  const rect = this.getBoundingClientRect(), style = getComputedStyle(this);
  let ancestor = this;
  while (ancestor) {
    const ancestorStyle = getComputedStyle(ancestor), transform = ancestorStyle.transform;
    if (ancestorStyle.perspective !== 'none') return fail('BROWSER_FRAME_TRANSFORM_UNSUPPORTED', '透视框架暂不支持坐标输入');
    if (transform !== 'none') { const matrix = new DOMMatrixReadOnly(transform); if (!matrix.is2D || matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0) return fail('BROWSER_FRAME_TRANSFORM_UNSUPPORTED', '旋转、翻转或透视框架暂不支持坐标输入'); }
    ancestor = ancestor.parentElement || ancestor.getRootNode()?.host;
  }
  if (!rect.width || !rect.height || this.closest('[inert]') || this.checkVisibility?.({ checkVisibilityCSS: true }) === false || style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return fail('BROWSER_FRAME_HIDDEN', '框架已隐藏');
  const scaleX = rect.width / this.offsetWidth, scaleY = rect.height / this.offsetHeight;
  const x = rect.left + this.clientLeft * scaleX + point.x * this.clientWidth * scaleX / viewport.width;
  const y = rect.top + this.clientTop * scaleY + point.y * this.clientHeight * scaleY / viewport.height;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return fail('BROWSER_FRAME_OFFSCREEN', '框架操作点不在上层视口中');
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) { const deeper = hit.shadowRoot.elementFromPoint(x, y); if (!deeper || deeper === hit) break; hit = deeper; }
  if (hit !== this && !this.contains(hit)) return fail('BROWSER_FRAME_OBSCURED', '框架被上层页面遮挡');
  return { x, y };
}
module.exports = { namedKeys, modifiers, parseKey, frameOwnerPoint };
