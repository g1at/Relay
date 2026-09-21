(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayKeyboardShortcuts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'relay.keyboard.shortcuts.v1';
  const ACTIONS = Object.freeze([
    { id: 'newChat', label: '新对话', description: '开始一个新的对话', group: '对话', defaults: ['Mod+N', 'Mod+Shift+O'] },
    { id: 'search', label: '搜索对话', description: '查找历史对话', group: '对话', defaults: ['Mod+K'] },
    { id: 'focusComposer', label: '聚焦输入框', description: '将光标移到当前对话输入框', group: '对话', defaults: ['Mod+L'] },
    { id: 'stopGeneration', label: '停止当前任务', description: '停止当前对话中正在执行的任务', group: '对话', defaults: ['Mod+Shift+X'] },
    { id: 'toggleSidebar', label: '展开或收起侧边栏', description: '切换侧边栏显示状态', group: '导航', defaults: ['Mod+B'] },
    { id: 'settings', label: '打开设置', description: '前往 Relay 设置', group: '导航', defaults: ['Mod+Comma'] },
    { id: 'shortcuts', label: '键盘快捷键', description: '查看与自定义键盘快捷键', group: '导航', defaults: ['Mod+Shift+K'] },
    { id: 'plugins', label: '打开插件', description: '管理技能、Agent 和 MCP', group: '导航', defaults: [] },
    { id: 'library', label: '打开资料库', description: '查看资料库内容', group: '导航', defaults: [] },
    { id: 'scheduler', label: '打开定时任务', description: '查看与管理定时任务', group: '导航', defaults: [] },
    { id: 'newBrowser', label: '新建浏览器', description: '在右侧工作区新建一个浏览器标签', group: '右侧工作区', defaults: ['Mod+Alt+1'] },
    { id: 'openFiles', label: '打开文件', description: '打开当前工作目录的文件列表', group: '右侧工作区', defaults: ['Mod+Alt+2'] },
    { id: 'newTerminal', label: '新建终端', description: '在当前工作目录新建独立终端标签', group: '右侧工作区', defaults: ['Mod+Alt+3'] },
    { id: 'openReview', label: '打开审查', description: '查看当前工作目录中的文件变更', group: '右侧工作区', defaults: ['Mod+Alt+4'] },
  ].map(item => Object.freeze({ ...item, defaults: Object.freeze(item.defaults) })));
  const ACTION_IDS = new Set(ACTIONS.map(item => item.id));
  const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];
  const NAMED_KEYS = [
    'Comma', 'Period', 'Slash', 'Backslash', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight',
    'Minus', 'Equal', 'Space', 'Enter', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
    'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Escape', 'Tab',
  ];
  const KEY_NAMES = new Map(NAMED_KEYS.map(key => [key.toLowerCase(), key]));
  const PUNCTUATION = {
    ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
    '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', ' ': 'Space',
  };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = value => value && typeof value === 'object' && !Array.isArray(value);

  function keyName(value) {
    if (typeof value !== 'string') return null;
    if (own(PUNCTUATION, value)) return PUNCTUATION[value];
    if (/^[a-z0-9]$/i.test(value)) return value.toUpperCase();
    if (/^F(?:[1-9]|1[0-2])$/i.test(value)) return value.toUpperCase();
    return KEY_NAMES.get(value.toLowerCase()) || null;
  }

  function canonicalChord(value) {
    if (typeof value !== 'string' || value.length > 96) return null;
    const parts = value.split('+').map(part => part.trim());
    if (!parts.length || parts.some(part => !part)) return null;
    const key = keyName(parts.pop());
    if (!key) return null;
    const modifiers = new Set();
    for (const part of parts) {
      const modifier = MODIFIERS.find(item => item.toLowerCase() === part.toLowerCase());
      if (!modifier || modifiers.has(modifier)) return null;
      modifiers.add(modifier);
    }
    return [...MODIFIERS.filter(item => modifiers.has(item)), key].join('+');
  }

  function validateChord(value) {
    const chord = canonicalChord(value);
    if (!chord) return { ok: false, error: '无法识别这个快捷键，请重新按下组合键。' };
    const parts = chord.split('+'), key = parts.pop(), modifiers = new Set(parts);
    const reject = error => ({ ok: false, chord, error });
    if (key === 'Escape' || key === 'Tab') return reject('Esc 和 Tab 用于取消或切换焦点，不能设为快捷键。');
    if (['F5', 'F11', 'F12'].includes(key)) return reject('这个按键用于刷新、全屏或开发者工具，请选择其他组合键。');
    if (modifiers.has('Alt') && ['F4', 'Space'].includes(key)) return reject('这个组合键由系统窗口操作使用，请选择其他组合键。');
    const primaryOnly = modifiers.has('Mod') && !modifiers.has('Ctrl') && !modifiers.has('Meta') && !modifiers.has('Alt');
    if (primaryOnly && (!modifiers.has('Shift') && ['A', 'C', 'V', 'X', 'Z', 'Y'].includes(key)
      || modifiers.has('Shift') && ['Z', 'V'].includes(key))) {
      return reject('这个组合键用于文本编辑，请保留复制、粘贴和撤销等操作。');
    }
    if (primaryOnly && ['Q', 'W', 'R'].includes(key)) return reject('这个组合键用于关闭或刷新窗口，请选择其他组合键。');
    if (key === 'Enter' && (modifiers.has('Mod') || modifiers.has('Shift'))) return reject('这个组合键用于发送消息、换行或创作操作，请选择其他组合键。');
    if (!modifiers.has('Mod') && !/^F(?:[1-9]|1[0-2])$/.test(key)) return reject('请使用包含 Ctrl（Mac 为 ⌘）的组合键，或 F1–F12 功能键。');
    return { ok: true, chord };
  }

  function chordFromEvent(event, isMac = false) {
    if (!event || event.repeat || event.isComposing || event.keyCode === 229
      || ['Process', 'Dead', 'Unidentified'].includes(event.key)) return null;
    try { if (event.getModifierState && event.getModifierState('AltGraph')) return null; } catch (_) {}
    if (!isMac && event.metaKey) return null;
    let key = null;
    if (typeof event.code === 'string') {
      if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
      else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
      else key = keyName(event.code);
    }
    if (!key) key = keyName(event.key);
    if (!key || key === 'Escape' || key === 'Tab') return null;
    const modifiers = [];
    if (isMac ? event.metaKey : event.ctrlKey) modifiers.push('Mod');
    if (isMac && event.ctrlKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    return [...modifiers, key].join('+');
  }

  function formatChord(value, isMac = false) {
    const chord = canonicalChord(value);
    if (!chord) return [];
    const labels = {
      Mod: isMac ? '⌘' : 'Ctrl', Ctrl: isMac ? '⌃' : 'Ctrl', Meta: isMac ? '⌘' : 'Win',
      Alt: isMac ? '⌥' : 'Alt', Shift: isMac ? '⇧' : 'Shift',
      Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
      BracketLeft: '[', BracketRight: ']', Minus: '−', Equal: '=', Space: 'Space',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc',
    };
    return chord.split('+').map(part => labels[part] || part);
  }

  function parsePreferences(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function ariaChord(value, isMac = false) {
    const chord = canonicalChord(value);
    if (!chord) return '';
    const labels = { Mod: isMac ? 'Meta' : 'Control', Ctrl: 'Control', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=' };
    return chord.split('+').map(part => labels[part] || part).join('+');
  }

  function normalizePreferences(raw) {
    const value = parsePreferences(raw);
    const source = record(value) && own(value, 'bindings') && record(value.bindings) ? value.bindings : {};
    const bindings = {}, claimed = new Set(), fallback = [];
    // Explicit choices take priority over defaults introduced by a missing action.
    for (const action of ACTIONS) {
      bindings[action.id] = [];
      if (!own(source, action.id) || !Array.isArray(source[action.id])) { fallback.push(action); continue; }
      for (const rawChord of source[action.id].slice(0, 256)) {
        const result = validateChord(rawChord);
        if (result.ok && !claimed.has(result.chord)) {
          bindings[action.id].push(result.chord); claimed.add(result.chord);
          if (bindings[action.id].length === 3) break;
        }
      }
    }
    for (const action of fallback) {
      for (const chord of action.defaults) if (!claimed.has(chord)) { bindings[action.id].push(chord); claimed.add(chord); }
    }
    return { version: 1, bindings };
  }

  function createStore(options = {}) {
    let storage = options.storage;
    if (!own(options, 'storage')) { try { storage = typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) {} }
    let initial;
    try { initial = storage && storage.getItem(STORAGE_KEY); } catch (_) {}
    let preferences = normalizePreferences(initial);
    const listeners = new Set();
    const snapshot = () => ({ version: 1, bindings: Object.fromEntries(ACTIONS.map(action => [action.id, [...preferences.bindings[action.id]]])) });
    const notify = () => {
      for (const listener of [options.onChange, ...listeners]) {
        if (typeof listener === 'function') { try { listener(snapshot()); } catch (_) {} }
      }
    };
    const failure = error => ({ ok: false, error });
    function conflict(chord, id, index) {
      for (const action of ACTIONS) {
        if (preferences.bindings[action.id].some((value, slot) => value === chord && !(action.id === id && slot === index))) {
          return { ok: false, conflictId: action.id, error: `这个快捷键已用于「${action.label}」，请先移除原绑定或选择其他组合键。` };
        }
      }
      return null;
    }
    function commit(next) {
      try {
        if (!storage || typeof storage.setItem !== 'function') return failure('无法访问本地存储，快捷键未保存。');
        storage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (_) { return failure('快捷键保存失败，请检查本地存储后重试。'); }
      preferences = next;
      notify();
      return { ok: true, preferences: snapshot() };
    }
    return {
      get: snapshot,
      getLabel(id, isMac = !!options.isMac) {
        return ACTION_IDS.has(id) ? formatChord(preferences.bindings[id][0], isMac).join('+') : '';
      },
      getAriaShortcuts(id, isMac = !!options.isMac) {
        return ACTION_IDS.has(id) ? preferences.bindings[id].map(chord => ariaChord(chord, isMac)).join(' ') : '';
      },
      assign(id, index, rawChord) {
        if (!ACTION_IDS.has(id)) return failure('未找到这个快捷键操作。');
        const bindings = preferences.bindings[id];
        if (!Number.isInteger(index) || index < 0 || index > bindings.length) return failure('快捷键位置已变化，请重新选择。');
        if (index === bindings.length && bindings.length >= 3) return failure('每项操作最多可设置 3 个快捷键。');
        const result = validateChord(rawChord);
        if (!result.ok) return result;
        const collision = conflict(result.chord, id, index);
        if (collision) return collision;
        const next = snapshot(); next.bindings[id][index] = result.chord;
        return commit(next);
      },
      remove(id, index) {
        if (!ACTION_IDS.has(id)) return failure('未找到这个快捷键操作。');
        if (!Number.isInteger(index) || index < 0 || index >= preferences.bindings[id].length) return failure('快捷键位置已变化，请重新选择。');
        const next = snapshot(); next.bindings[id].splice(index, 1);
        return commit(next);
      },
      reset(id) {
        if (id == null) return commit(normalizePreferences(null));
        if (!ACTION_IDS.has(id)) return failure('未找到这个快捷键操作。');
        const action = ACTIONS.find(item => item.id === id);
        for (const chord of action.defaults) {
          for (const other of ACTIONS) if (other.id !== id && preferences.bindings[other.id].includes(chord)) {
            return { ok: false, conflictId: other.id, error: `默认快捷键已用于「${other.label}」，请先移除原绑定。` };
          }
        }
        const next = snapshot(); next.bindings[id] = [...action.defaults];
        return commit(next);
      },
      receive(value) {
        preferences = normalizePreferences(value); notify();
        return { ok: true, preferences: snapshot() };
      },
      subscribe(listener) {
        if (typeof listener === 'function') listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  return { ACTIONS, STORAGE_KEY, normalizePreferences, chordFromEvent, formatChord, validateChord, createStore };
});
