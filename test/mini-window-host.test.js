'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createMiniWindowHost, isQuickChatEnabled, normalizeQuickChatPatch } = require('../src/main/app/mini-window-host');

function fixture(t, initial = {}) {
  let settings = structuredClone(initial), clock = 0, nextTimer = 0, failWrites = false;
  const pending = new Map(), windows = [], writes = [], states = [], menus = [], callbacks = [], errors = [];
  const timers = {
    now: () => clock,
    setTimeout(fn, delay) { const id = ++nextTimer; pending.set(id, { fn, due: clock + delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    stall(ms) { clock += ms; },
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        const entry = [...pending].filter(([, task]) => task.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!entry) break;
        pending.delete(entry[0]); clock = Math.max(clock, entry[1].due); entry[1].fn();
      }
      clock = end;
    },
  };
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, options[key]]));
      this.destroyed = false; this.visible = false; this.focusCount = 0; this.top = options.alwaysOnTop;
      this.frames = [];
      this.webContents = new EventEmitter(); this.webContents.sent = [];
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.send = (...args) => this.webContents.sent.push(args);
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; this.frames.push({ at: clock, ...bounds }); this.emit('move'); this.emit('resize'); }
    setVisibleOnAllWorkspaces(value) { this.allWorkspaces = value; }
    setAlwaysOnTop(value) { this.top = value; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; this.inactive = true; }
    hide() { this.visible = false; }
    focus() { this.focusCount++; }
    loadFile(file) { this.file = file; }
    ready() { this.webContents.emit('did-finish-load'); this.emit('ready-to-show'); }
    close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) this.destroy(); }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const screen = new EventEmitter();
  screen.cursor = { x: 1200, y: 700 };
  screen.displays = [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }];
  screen.getCursorScreenPoint = () => ({ ...screen.cursor });
  screen.getDisplayMatching = rect => screen.displays.map(display => {
    const a = display.workArea;
    const overlap = Math.max(0, Math.min(a.x + a.width, rect.x + rect.width) - Math.max(a.x, rect.x))
      * Math.max(0, Math.min(a.y + a.height, rect.y + rect.height) - Math.max(a.y, rect.y));
    const distance = Math.hypot(rect.x + rect.width / 2 - a.x - a.width / 2, rect.y + rect.height / 2 - a.y - a.height / 2);
    return { display, score: overlap > 0 ? overlap : -distance };
  }).sort((a, b) => b.score - a.score)[0].display;
  screen.getDisplayNearestPoint = pt => screen.getDisplayMatching({ ...pt, width: 1, height: 1 });
  const Menu = { buildFromTemplate(template) { const menu = { template, popup(input) { this.popupInput = input; } }; menus.push(menu); return menu; } };
  const host = createMiniWindowHost({ BrowserWindow: FakeWindow, screen, Menu,
    rootDir: path.resolve('synthetic-relay'), timers,
    readSettings: () => structuredClone(settings),
    writeSettings: next => { if (failWrites) throw Error('Synthetic read-only settings'); writes.push(structuredClone(next)); settings = structuredClone(next); },
    onOpenMain: () => callbacks.push('main'), onDisableOrb: () => callbacks.push('disable'),
    onStateChange: state => states.push(state),
    onError: error => errors.push(error.message),
  });
  t.after(() => host.destroy());
  return { host, windows, timers, pending, screen, writes, states, menus, callbacks, errors,
    get settings() { return settings; }, update(next) { settings = { ...settings, ...structuredClone(next) }; },
    failWrites() { failWrites = true; },
    panel() { host.show(); const win = host.getPanelWindow(); win.ready(); return win; },
    orb() { host.start(); const win = host.getOrbWindow(); win.ready(); return win; },
  };
}

test('startup creates one nonfocusing secure orb, loading no chat window until requested', t => {
  const h = fixture(t); assert.equal(h.states.length, 0); assert.equal(h.windows.length, 0);
  const orb = h.orb(); h.host.start();
  assert.equal(h.windows.length, 1); assert.equal(h.host.getPanelWindow(), null);
  assert.match(orb.file, /renderer[/\\]floating-orb\.html$/);
  assert.deepEqual([orb.options.width, orb.options.height], [64, 64]);
  assert.equal(orb.focusCount, 0); assert.equal(orb.inactive, true); assert.equal(orb.options.focusable, false);
  assert.equal(orb.options.frame, false); assert.equal(orb.options.transparent, true);
  assert.equal(orb.options.skipTaskbar, true); assert.equal(orb.options.alwaysOnTop, true);
  assert.equal(orb.options.webPreferences.nodeIntegration, false);
  assert.equal(orb.options.webPreferences.contextIsolation, true);
  assert.deepEqual(orb.openHandler(), { action: 'deny' });
  for (const event of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) {
    let denied = false; orb.webContents.emit(event, { preventDefault() { denied = true; } }); assert.equal(denied, true);
  }
});

test('blur and window close keep the chat session alive; toggling reuses its window and position', t => {
  const h = fixture(t), panel = h.panel();
  assert.deepEqual([panel.bounds.width, panel.bounds.height], [460, 246]);
  panel.emit('blur'); assert.equal(panel.isVisible(), true);
  panel.setBounds({ x: 40, y: 70, width: 640, height: 420 });
  h.host.toggle(); assert.equal(panel.isVisible(), false); assert.equal(panel.isDestroyed(), false);
  h.host.toggle(); assert.equal(panel.isVisible(), true); assert.equal(h.windows.length, 1);
  assert.deepEqual(panel.getBounds(), { x: 40, y: 70, width: 640, height: 420 });
  panel.close(); assert.equal(panel.isVisible(), false); assert.equal(panel.isDestroyed(), false);
  assert.equal(h.host.getState().requestedVisible, false);
  assert.equal(panel.webContents.sent.some(([event]) => event === 'mini:focus'), true);
});

test('toggle before first load does not reopen a panel hidden during startup', t => {
  const h = fixture(t); h.host.toggle(); const panel = h.host.getPanelWindow();
  assert.equal(h.host.getState().requestedVisible, true); assert.equal(panel.isVisible(), false);
  h.host.toggle(); panel.ready(); assert.equal(panel.isVisible(), false);
  h.host.show(); assert.equal(panel.isVisible(), true);
});

test('legacy split preferences keep both quick-chat entrances available until explicitly disabled', t => {
  const h = fixture(t, { miniInputEnabled: false, floatingOrbEnabled: true });
  const orb = h.orb(); assert.equal(orb.isVisible(), true);
  assert.equal(h.host.show({ source: 'shortcut' }).ok, true);
  assert.equal(h.host.show({ source: 'orb' }).ok, true);
  const panel = h.host.getPanelWindow(); panel.ready();
  h.update({ floatingOrbEnabled: false, miniInputEnabled: true }); h.host.syncSettings();
  assert.equal(orb.isVisible(), true); assert.equal(panel.isVisible(), true);
  assert.equal(h.host.show({ source: 'orb' }).ok, true);
  assert.equal(h.host.show({ source: 'shortcut' }).ok, true);
  h.update({ quickChatEnabled: false }); h.host.syncSettings();
  assert.equal(panel.isVisible(), false); assert.equal(orb.isVisible(), false);
  assert.equal(panel.isDestroyed(), false); assert.equal(orb.isDestroyed(), true);
  assert.equal(h.host.getOrbWindow(), null);
  assert.equal(h.host.show().ok, false);
  h.update({ quickChatEnabled: true }); h.host.syncSettings();
  const restoredOrb = h.host.getOrbWindow(); restoredOrb.ready();
  assert.notEqual(restoredOrb, orb); assert.equal(restoredOrb.isVisible(), true);
  assert.equal(h.host.show({ source: 'shortcut' }).ok, true);
  assert.equal(h.host.getPanelWindow(), panel); assert.equal(panel.isVisible(), true);
});

test('disabled features create no windows and later enabling the orb is lazy and nonfocusing', t => {
  const h = fixture(t, { miniInputEnabled: false, floatingOrbEnabled: false });
  h.host.start(); assert.equal(h.windows.length, 0);
  h.update({ floatingOrbEnabled: true }); h.host.syncSettings(); const orb = h.host.getOrbWindow();
  assert.ok(orb); orb.ready(); assert.equal(orb.isVisible(), true); assert.equal(orb.focusCount, 0);
});

test('saved panel and orb positions restore on a negative-coordinate monitor and clamp removed displays', t => {
  const h = fixture(t, { miniWindowBounds: { x: -1200, y: 110, width: 640, height: 430 }, floatingOrbPosition: { x: -110, y: 410 } });
  h.screen.displays.unshift({ workArea: { x: -1280, y: 0, width: 1280, height: 800 } });
  const orb = h.orb(), panel = h.panel();
  assert.equal(panel.bounds.x, -1200); assert.equal(orb.bounds.x, -110);
  h.screen.displays.shift(); h.screen.emit('display-removed');
  assert.equal(panel.bounds.x, 12); assert.equal(orb.bounds.x, 12);
  assert.deepEqual(h.settings.miniWindowBounds, panel.getBounds());
  assert.deepEqual(h.settings.floatingOrbPosition, { x: 12, y: 410 });
});

test('first orb-opened panel appears beside the orb within its monitor', t => {
  const h = fixture(t, { floatingOrbPosition: { x: 1340, y: 760 } }); h.orb();
  h.host.show({ source: 'orb' }); const panel = h.host.getPanelWindow(); panel.ready();
  assert.equal(panel.bounds.x, 868); assert.ok(panel.bounds.y + panel.bounds.height <= 888);
  assert.equal(panel.bounds.height, 246);
});

test('invalid saved bounds fall back to sensible defaults rather than crossing screen boundaries', t => {
  const h = fixture(t, { miniWindowBounds: { x: NaN, y: 4, width: -1, height: 9999 }, floatingOrbPosition: { x: 'bad', y: 8 } });
  const orb = h.orb(), panel = h.panel();
  assert.equal(panel.bounds.width, 460); assert.equal(panel.bounds.height, 246);
  assert.ok(Number.isFinite(panel.bounds.x)); assert.ok(Number.isFinite(orb.bounds.x));
});

test('height smoothly expands with bottom correction and commits the final bounds once', t => {
  const h = fixture(t, { miniWindowBounds: { x: 100, y: 680, width: 640, height: 190 } });
  const panel = h.panel(), result = h.host.resize(580);
  assert.deepEqual(result.bounds, { x: 100, y: 308, width: 520, height: 580 });
  h.timers.advance(64);
  assert.ok(panel.bounds.height > 246 && panel.bounds.height < 580);
  assert.ok(panel.bounds.y < 642 && panel.bounds.y > 308);
  h.timers.advance(400);
  assert.deepEqual(panel.getBounds(), result.bounds); assert.deepEqual(h.settings.miniWindowBounds, result.bounds);
  const count = h.writes.length; h.host.resize(580); h.timers.advance(200); assert.equal(h.writes.length, count);
});

test('resize clamps huge and negative heights, respects reduced motion and narrow work areas', t => {
  const h = fixture(t); h.screen.displays = [{ workArea: { x: 30, y: 40, width: 480, height: 500 } }];
  const panel = h.panel(); assert.equal(panel.bounds.width, 456);
  h.host.resize(999999, { reduceMotion: true });
  assert.equal(panel.bounds.height, 476); assert.equal(panel.bounds.y, 52);
  h.host.resize(-300, { reduceMotion: true }); assert.equal(panel.bounds.height, 246);
  for (const height of [NaN, Infinity, undefined, '500', {}]) assert.equal(h.host.resize(height).ok, false);
  assert.ok(h.pending.size <= 1);
});

test('new height replaces an unfinished animation; manual window dragging cancels motion', t => {
  const h = fixture(t), panel = h.panel(); h.host.resize(650); h.timers.advance(48);
  h.host.resize(380); h.timers.advance(400); assert.equal(panel.bounds.height, 380);
  h.host.resize(650); h.timers.advance(32); panel.emit('will-move');
  panel.setBounds({ x: 99, y: 88, width: 640, height: 420 }); h.timers.advance(300);
  assert.deepEqual(panel.getBounds(), { x: 99, y: 88, width: 640, height: 420 });
});

test('resize-observer feedback every 32ms cannot restart or starve an unchanged expansion', t => {
  const h = fixture(t), panel = h.panel();
  const target = h.host.resize(600).bounds;
  for (let i = 0; i < 12; i++) { h.timers.advance(32); h.host.resize(600); }
  assert.deepEqual(panel.getBounds(), target);
  assert.equal(h.pending.size, 0);
  assert.deepEqual(h.settings.miniWindowBounds, target);
  h.host.destroy(); assert.equal(h.pending.size, 0);
});

test('legacy compact bounds migrate to the new minimum, including work areas shorter than that minimum', t => {
  const legacy = { x: 120, y: 160, width: 520, height: 190 };
  const h = fixture(t, { miniWindowBounds: legacy }), panel = h.panel();
  assert.deepEqual(panel.getBounds(), { ...legacy, width: 460, height: 246 });
  h.host.hide(); assert.equal(h.settings.miniWindowBounds.height, 246);
  const small = fixture(t, { miniWindowBounds: legacy });
  small.screen.displays = [{ workArea: { x: -400, y: 100, width: 480, height: 240 } }];
  const compact = small.panel();
  assert.equal(compact.bounds.height, 216); assert.equal(compact.bounds.width, 456);
  assert.equal(compact.bounds.y, 112); assert.equal(compact.bounds.y + compact.bounds.height, 328);
});

test('old fixed defaults migrate at startup while retaining position and expanded height', t => {
  const compact = fixture(t, { miniWindowBounds: { x: 180, y: 140, width: 520, height: 270 } });
  assert.deepEqual(compact.panel().getBounds(), { x: 180, y: 140, width: 460, height: 246 });
  compact.host.hide();
  assert.deepEqual(compact.settings.miniWindowBounds, { x: 180, y: 140, width: 460, height: 246 });
  const expanded = fixture(t, { miniWindowBounds: { x: 180, y: 140, width: 520, height: 560 } });
  assert.deepEqual(expanded.panel().getBounds(), { x: 180, y: 140, width: 460, height: 560 });
  const edge = fixture(t, { miniWindowBounds: { x: 1340, y: 800, width: 520, height: 270 } });
  assert.deepEqual(edge.panel().getBounds(), { x: 968, y: 642, width: 460, height: 246 });
});

test('legacy-size migration is not reapplied to a running panel after resizing or showing', t => {
  const h = fixture(t, { miniWindowBounds: { x: 80, y: 40, width: 900, height: 900 } });
  const panel = h.panel();
  assert.equal(panel.bounds.width, 520, 'abnormally large saved widths are capped rather than treated as the old default');
  h.host.resize(270, { reduceMotion: true }); h.host.syncSettings();
  h.host.hide(); h.host.show();
  assert.equal(h.host.getPanelWindow(), panel);
  assert.deepEqual(panel.getBounds(), { x: 80, y: 40, width: 520, height: 270 });
});

test('saved and requested panel sizes obey compact width and height limits', t => {
  const large = fixture(t, { miniWindowBounds: { x: 80, y: 40, width: 900, height: 900 } });
  const panel = large.panel();
  assert.deepEqual(panel.getBounds(), { x: 80, y: 40, width: 520, height: 600 });
  large.host.hide(); assert.equal(large.settings.miniWindowBounds.width, 520);
  assert.equal(large.settings.miniWindowBounds.height, 600);
  const small = fixture(t, { miniWindowBounds: { x: 80, y: 40, width: 320, height: 190 } });
  assert.deepEqual(small.panel().getBounds(), { x: 80, y: 40, width: 460, height: 246 });
  const retained = fixture(t, { miniWindowBounds: { x: 80, y: 40, width: 500, height: 400 } });
  const middle = retained.panel();
  retained.host.resize(99999); retained.timers.advance(400);
  assert.equal(middle.bounds.width, 500); assert.equal(middle.bounds.height, 600);
  assert.ok(middle.frames.every(frame => frame.width <= 520 && frame.height <= 600));
  retained.host.resize(0, { reduceMotion: true });
  assert.equal(middle.bounds.height, 246); assert.equal(middle.bounds.width, 500);
});

test('expansion starts gently and a streaming target update keeps existing momentum', t => {
  const h = fixture(t), panel = h.panel();
  h.host.resize(530);
  assert.equal(panel.bounds.height, 246, 'requesting a resize never jumps the native bounds');
  h.timers.advance(16); const first = panel.bounds.height - 246;
  assert.ok(first > 0 && first < (530 - 246) * 0.1, 'the first frame eases into motion');
  h.timers.advance(16); const second = panel.bounds.height - 246 - first;
  assert.ok(second > first, 'initial velocity builds gradually');
  h.timers.advance(32);
  const previousStep = panel.frames.at(-1).height - panel.frames.at(-2).height;
  const beforeRetarget = panel.getBounds(); h.host.resize(600);
  assert.deepEqual(panel.getBounds(), beforeRetarget);
  h.timers.advance(16);
  assert.ok(panel.bounds.height - beforeRetarget.height >= previousStep * 0.7,
    'a token update continues the existing movement instead of restarting a slow first frame');
  assert.equal(h.writes.length, 0);
  h.timers.advance(400);
  assert.equal(panel.bounds.height, 600); assert.equal(h.pending.size, 0);
  assert.equal(h.writes.length, 1, 'only the settled bounds are persisted');
});

test('a blocked main loop advances only a bounded animation step when frames resume', t => {
  const h = fixture(t), panel = h.panel();
  const reference = fixture(t), normal = reference.panel();
  h.host.resize(600); reference.host.resize(600);
  h.timers.advance(48); reference.timers.advance(48);
  const before = panel.getBounds(), frameCount = panel.frames.length;
  h.timers.stall(180);
  assert.deepEqual(panel.getBounds(), before, 'no native frames can run during the stall');
  h.timers.advance(0); reference.timers.advance(32);
  assert.equal(panel.frames.length, frameCount + 1, 'resume produces one bounded frame rather than replaying missed frames');
  assert.ok(panel.bounds.height > before.height && panel.bounds.height < 600);
  assert.ok(Math.abs(panel.bounds.height - normal.bounds.height) <= 1,
    '180ms of blocked wall time advances no farther than two normal 16ms steps');
  assert.equal(h.writes.length, 0, 'a delayed frame does not prematurely persist completion');
  h.host.resize(580); h.timers.advance(16);
  assert.ok(panel.bounds.height > normal.bounds.height, 'retargeting after the stall still carries forward its velocity');
  h.timers.advance(450);
  assert.equal(panel.bounds.height, 580); assert.equal(h.pending.size, 0);
  assert.equal(h.writes.length, 1); assert.equal(h.settings.miniWindowBounds.height, 580);
});

test('frequent growing targets remain monotonic, stay on screen and settle promptly after the last token', t => {
  const h = fixture(t, { miniWindowBounds: { x: 80, y: 610, width: 520, height: 246 } });
  const panel = h.panel();
  // Deliberately leave an older move persistence timer pending before growth.
  panel.setBounds(panel.getBounds());
  let target;
  for (const height of [430, 480, 530, 580, 630, 680, 730, 780]) {
    target = h.host.resize(height).bounds;
    h.timers.advance(32);
    assert.ok(panel.bounds.height <= height, 'growth never crosses its latest target');
    assert.equal(h.writes.length, 0, 'old movement timers cannot save intermediate animation frames');
  }
  h.timers.advance(400);
  assert.deepEqual(panel.getBounds(), target); assert.equal(h.pending.size, 0);
  assert.equal(h.writes.length, 1); assert.deepEqual(h.settings.miniWindowBounds, target);
  for (let i = 0; i < panel.frames.length; i++) {
    const frame = panel.frames[i];
    assert.ok(frame.x >= 12 && frame.y >= 12 && frame.x + frame.width <= 1428 && frame.y + frame.height <= 888);
    if (i) assert.ok(frame.height >= panel.frames[i - 1].height, 'token retargeting cannot shrink a growing panel');
  }
});

test('nearer and reversed targets brake without overshoot or stale completion writes', t => {
  const h = fixture(t), panel = h.panel();
  h.host.resize(720); h.timers.advance(80);
  const closer = panel.bounds.height + 10, start = panel.bounds.height;
  let from = panel.frames.length;
  h.host.resize(closer); h.timers.advance(400);
  assert.equal(panel.bounds.height, closer);
  for (const frame of panel.frames.slice(from)) assert.ok(frame.height >= start && frame.height <= closer);
  h.host.resize(760); h.timers.advance(64);
  const reversed = panel.bounds.height;
  from = panel.frames.length; h.host.resize(246); h.timers.advance(400);
  assert.equal(panel.bounds.height, 246);
  let previous = reversed;
  for (const frame of panel.frames.slice(from)) {
    assert.ok(frame.height <= previous && frame.height >= 246); previous = frame.height;
    assert.ok(frame.y >= 12 && frame.y + frame.height <= 888, 'reversing a bottom-corrected animation stays on screen');
  }
  assert.equal(h.settings.miniWindowBounds.height, 246); assert.equal(h.pending.size, 0);
});

test('reduced motion immediately finishes even when the requested target has not changed', t => {
  const h = fixture(t), panel = h.panel();
  const target = h.host.resize(680).bounds; h.timers.advance(32);
  assert.notEqual(panel.bounds.height, target.height);
  h.host.resize(680, { reduceMotion: true });
  assert.deepEqual(panel.getBounds(), target); assert.equal(h.pending.size, 0);
  const written = h.writes.length; h.timers.advance(500); assert.equal(h.writes.length, written);
  h.host.resize(300); h.timers.advance(32);
  h.update({ reduceMotion: true }); h.host.syncSettings();
  assert.equal(panel.bounds.height, 300); assert.equal(h.pending.size, 0);
});

test('same-size hidden and reduced-motion requests cannot cause notification feedback loops', t => {
  const h = fixture(t), panel = h.panel(); h.host.hide();
  let states = h.states.length, writes = h.writes.length;
  for (let i = 0; i < 20; i++) h.host.resize(panel.bounds.height);
  h.timers.advance(500);
  assert.equal(h.states.length, states); assert.equal(h.writes.length, writes); assert.equal(h.pending.size, 0);
  h.host.show(); states = h.states.length; writes = h.writes.length;
  for (let i = 0; i < 20; i++) h.host.resize(panel.bounds.height, { reduceMotion: true });
  h.timers.advance(500);
  assert.equal(h.states.length, states); assert.equal(h.writes.length, writes); assert.equal(h.pending.size, 0);
});

test('hide and screen scaling cancel motion without stale timers moving the panel afterwards', t => {
  const h = fixture(t), panel = h.panel(); h.host.start();
  h.host.resize(800); h.timers.advance(48); h.host.hide();
  const hidden = panel.getBounds(), count = h.writes.length;
  h.timers.advance(600);
  assert.deepEqual(panel.getBounds(), hidden); assert.equal(h.writes.length, count);
  assert.equal(h.pending.size, 0);
  h.host.show(); h.host.resize(800); h.timers.advance(64);
  h.screen.displays = [{ workArea: { x: 30, y: 40, width: 480, height: 420 } }];
  h.screen.emit('display-metrics-changed');
  const scaled = panel.getBounds(); h.timers.advance(600);
  assert.deepEqual(panel.getBounds(), scaled); assert.equal(h.pending.size, 0);
  assert.ok(scaled.x >= 42 && scaled.y >= 52 && scaled.x + scaled.width <= 498 && scaled.y + scaled.height <= 448);
  assert.deepEqual(h.settings.miniWindowBounds, scaled);
});

test('panel moves and pin changes merge into current preferences without overwriting unrelated settings', t => {
  const h = fixture(t, { brandName: 'Before' }), panel = h.panel();
  panel.setBounds({ x: 200, y: 100, width: 640, height: 400 });
  h.update({ brandName: 'After', providerChoice: 'preserve' }); h.timers.advance(151);
  assert.equal(h.settings.brandName, 'After'); assert.equal(h.settings.providerChoice, 'preserve');
  h.host.setPinned(false); assert.equal(panel.top, false); assert.equal(h.settings.miniWindowPinned, false);
  h.host.hide(); h.host.show(); assert.equal(panel.top, false);
  assert.equal(h.host.setPinned('false').ok, false);
  h.update({ miniWindowPinned: true }); h.host.syncSettings(); assert.equal(panel.top, true);
});

test('orb drag uses the OS cursor, distinguishes a click and persists a clamped position', t => {
  const h = fixture(t, { floatingOrbPosition: { x: 1200, y: 600 } }), orb = h.orb();
  assert.equal(h.host.orbDrag({ phase: 'move' }).ok, false);
  h.screen.cursor = { x: 1210, y: 610 }; h.host.orbDrag({ phase: 'start' });
  h.screen.cursor = { x: 1211, y: 611 };
  assert.equal(h.host.orbDrag({ phase: 'end', x: -90000, y: -90000 }).moved, false);
  assert.equal(orb.bounds.x, 1200);
  h.host.orbDrag({ phase: 'start' }); h.screen.cursor = { x: 4000, y: -2000 };
  const result = h.host.orbDrag({ phase: 'move', x: 100, y: 100 }); assert.equal(result.moved, true);
  assert.deepEqual(orb.getBounds(), { x: 1364, y: 12, width: 64, height: 64 });
  assert.equal(h.host.orbDrag({ phase: 'end' }).moved, true);
  assert.deepEqual(h.settings.floatingOrbPosition, { x: 1364, y: 12 });
});

test('session hide releases the orb renderer; explicit show restores its position without replacing the chat', t => {
  const h = fixture(t), orb = h.orb();
  const panel = h.panel();
  orb.setBounds({ x: 340, y: 230, width: 64, height: 64 });
  h.host.hideOrbForSession(); h.host.syncSettings(); assert.equal(orb.isVisible(), false);
  assert.equal(orb.isDestroyed(), true); assert.equal(h.host.getOrbWindow(), null);
  assert.equal(h.host.ownsWebContents(orb.webContents), false);
  assert.equal(h.host.getPanelWindow(), panel); assert.equal(panel.isVisible(), true);
  assert.deepEqual(h.settings.floatingOrbPosition, { x: 340, y: 230 });
  assert.notEqual(h.settings.floatingOrbEnabled, false);
  h.update({ floatingOrbEnabled: false }); h.host.syncSettings();
  h.update({ floatingOrbEnabled: true }); h.host.syncSettings(); assert.equal(orb.isVisible(), false);
  assert.equal(h.host.getOrbWindow(), null, 'settings refresh cannot undo session hiding');
  h.host.showOrb(); const replacement = h.host.getOrbWindow(); replacement.ready();
  assert.equal(replacement.isVisible(), true); assert.notEqual(replacement, orb);
  assert.deepEqual(replacement.getBounds(), { x: 340, y: 230, width: 64, height: 64 });
  assert.equal(replacement.focusCount, 0); assert.equal(h.host.getPanelWindow(), panel);
  replacement.close(); assert.equal(replacement.isDestroyed(), true); assert.equal(h.host.getOrbWindow(), null);
});

test('disabling during orb load releases its renderer and ignores stale ready events', t => {
  const h = fixture(t); h.host.start();
  const first = h.host.getOrbWindow();
  h.update({ quickChatEnabled: false }); h.host.syncSettings();
  assert.equal(first.isDestroyed(), true); assert.equal(h.host.getOrbWindow(), null);
  assert.equal(h.windows.filter(win => !win.isDestroyed()).length, 0);
  assert.equal(h.host.getPanelWindow(), null); assert.equal(h.host.show({ source: 'shortcut' }).ok, false);
  h.update({ quickChatEnabled: true }); h.host.syncSettings();
  const replacement = h.host.getOrbWindow();
  first.ready(); assert.equal(replacement.isVisible(), false, 'an old load must not reveal its replacement early');
  replacement.ready(); assert.equal(replacement.isVisible(), true);
  h.host.show({ source: 'shortcut' }); const panel = h.host.getPanelWindow(); panel.ready();
  assert.equal(panel.isVisible(), true, 'Alt+Space still opens the lazily loaded panel after re-enabling');
});

test('repeated feature toggles retain one chat panel and no disabled orb renderers', t => {
  const h = fixture(t), panel = h.panel(); h.orb();
  for (let i = 0; i < 10; i++) {
    h.update({ quickChatEnabled: false }); h.host.syncSettings();
    assert.deepEqual(h.windows.filter(win => !win.isDestroyed()), [panel]);
    assert.equal(panel.isVisible(), false); assert.equal(h.host.isPanelSender(panel.webContents), true);
    h.update({ quickChatEnabled: true }); h.host.syncSettings();
    const orb = h.host.getOrbWindow(); orb.ready();
    assert.equal(h.windows.filter(win => !win.isDestroyed()).length, 2);
    h.host.show({ source: 'shortcut' }); assert.equal(h.host.getPanelWindow(), panel);
  }
});

test('orb context menu opens chat/main, hides for this session, or disables persistently', t => {
  const h = fixture(t); const orb = h.orb();
  assert.equal(h.host.showContextMenu().ok, true); const menu = h.menus[0];
  assert.equal(menu.popupInput.window, orb);
  menu.template[0].click(); assert.ok(h.host.getPanelWindow());
  menu.template[1].click(); assert.deepEqual(h.callbacks, ['main']);
  menu.template[3].click(); assert.equal(orb.isVisible(), false); h.host.showOrb();
  menu.template[4].click(); assert.equal(h.settings.floatingOrbEnabled, false);
  assert.equal(h.settings.miniInputEnabled, false); assert.equal(h.settings.quickChatEnabled, false);
  assert.equal(h.host.show({ source: 'shortcut' }).ok, false);
  assert.equal(orb.isVisible(), false); assert.deepEqual(h.callbacks, ['main', 'disable']);
  assert.equal(h.host.showOrb().ok, false);
});

test('sender ownership and quit cleanup reject stale windows and cancel all timers/listeners', t => {
  const h = fixture(t), orb = h.orb(), panel = h.panel();
  assert.equal(h.host.isPanelSender(panel.webContents), true);
  assert.equal(h.host.isPanelSender(orb.webContents), false);
  assert.equal(h.host.ownsWebContents(orb.webContents), true);
  assert.equal(h.host.ownsWebContents({}), false);
  h.host.resize(600); h.timers.advance(32); h.host.destroy();
  assert.equal(panel.isDestroyed(), true); assert.equal(orb.isDestroyed(), true);
  assert.equal(h.pending.size, 0);
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(h.screen.listenerCount(event), 0);
  const windows = h.windows.length, writes = h.writes.length;
  h.timers.advance(1000); h.host.start(); h.host.show(); h.host.showOrb(); h.host.destroy();
  assert.equal(h.windows.length, windows); assert.equal(h.writes.length, writes);
  assert.equal(h.host.getPanelWindow(), null); assert.equal(h.host.ownsWebContents(panel.webContents), false);
});

test('settings write failures never crash movement timers or prevent quit cleanup', t => {
  const h = fixture(t), orb = h.orb(), panel = h.panel(); h.failWrites();
  panel.setBounds({ x: 50, y: 70, width: 640, height: 400 });
  assert.doesNotThrow(() => h.timers.advance(200));
  assert.equal(h.host.setPinned(false).ok, false); assert.ok(h.errors.length >= 2);
  assert.doesNotThrow(() => h.host.destroy());
  assert.equal(orb.isDestroyed(), true); assert.equal(panel.isDestroyed(), true); assert.equal(h.pending.size, 0);
});


test('quick-chat preference migration defaults on and keeps explicit unified state authoritative', () => {
  for (const settings of [{}, { miniInputEnabled: false, floatingOrbEnabled: true }, { miniInputEnabled: true, floatingOrbEnabled: false }]) {
    assert.equal(isQuickChatEnabled(settings), true);
  }
  assert.equal(isQuickChatEnabled({ miniInputEnabled: false, floatingOrbEnabled: false }), false);
  assert.equal(isQuickChatEnabled({ quickChatEnabled: false, miniInputEnabled: true, floatingOrbEnabled: true }), false);
  assert.equal(isQuickChatEnabled({ quickChatEnabled: true, miniInputEnabled: false, floatingOrbEnabled: false }), true);
  assert.deepEqual(normalizeQuickChatPatch({ theme: 'dark' }), {});
  for (const patch of [{ quickChatEnabled: false }, { miniInputEnabled: false }, { floatingOrbEnabled: false }]) {
    assert.deepEqual(normalizeQuickChatPatch(patch), { quickChatEnabled: false, miniInputEnabled: false, floatingOrbEnabled: false });
  }
  assert.deepEqual(normalizeQuickChatPatch({ miniInputEnabled: false, floatingOrbEnabled: true }),
    { quickChatEnabled: true, miniInputEnabled: true, floatingOrbEnabled: true });
  assert.throws(() => normalizeQuickChatPatch({ quickChatEnabled: 'false' }), { code: 'INVALID_SETTING' });
});
