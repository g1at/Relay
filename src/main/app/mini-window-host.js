'use strict';

const path = require('node:path');
const { appRoot } = require('./paths');

const PANEL_WIDTH = 460;
const PANEL_MAX_WIDTH = 520;
const PANEL_MIN_HEIGHT = 246;
const PANEL_MAX_HEIGHT = 600;
const ORB_SIZE = 64;
const MARGIN = 12;
const SPRING_FREQUENCY = 28;
const FRAME_MS = 16;
const MAX_FRAME_ADVANCE_MS = 32;

// The old shortcut and orb preferences represented two entrances to one feature.
// Keep access available during migration when either entrance was enabled.
function isQuickChatEnabled(settings = {}) {
  if (typeof settings.quickChatEnabled === 'boolean') return settings.quickChatEnabled;
  return settings.miniInputEnabled !== false || settings.floatingOrbEnabled !== false;
}

function normalizeQuickChatPatch(patch = {}) {
  const keys = ['quickChatEnabled', 'miniInputEnabled', 'floatingOrbEnabled'];
  const present = keys.filter(key => Object.hasOwn(patch, key));
  if (!present.length) return {};
  if (present.some(key => typeof patch[key] !== 'boolean')) {
    throw Object.assign(new TypeError('快捷小窗开关必须为开启或关闭'), { code: 'INVALID_SETTING' });
  }
  const enabled = Object.hasOwn(patch, 'quickChatEnabled') ? patch.quickChatEnabled
    : present.some(key => patch[key]);
  return { quickChatEnabled: enabled, miniInputEnabled: enabled, floatingOrbEnabled: enabled };
}

// Window lifecycle and placement only. Chat execution stays in the shared Relay
// session service. Keep the chat panel (and its draft) alive when hidden; the
// stateless orb can release its renderer until the user explicitly restores it.
function createMiniWindowHost(options) {
  const { BrowserWindow, screen, Menu, rootDir = appRoot,
    readSettings = () => ({}), writeSettings = () => {},
    onOpenMain = () => {}, onDisableOrb = () => {}, onStateChange = () => {},
    onError = error => console.warn('[mini-window] %s', error.message) } = options;
  if (!BrowserWindow || !screen) throw new TypeError('Mini windows require BrowserWindow and screen');
  const timers = options.timers || { setTimeout, clearTimeout, now: Date.now };
  let panel = null, orb = null, panelReady = false, orbReady = false;
  let panelWanted = false, orbHiddenForSession = false, disposed = false, started = false;
  let animation = null, persistTimer = null, drag = null;
  let settings = readSettings() || {};
  let pinned = settings.miniWindowPinned !== false;
  const alive = win => !!win && !win.isDestroyed();
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const safeBounds = value => value && ['x', 'y', 'width', 'height'].every(key => finite(value[key]))
    && value.width > 0 && value.height > 0;
  const safePosition = value => value && finite(value.x) && finite(value.y);

  function workArea(rect) {
    const display = rect && screen.getDisplayMatching
      ? screen.getDisplayMatching(rect)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return display.workArea;
  }

  function clamp(rect, area = workArea(rect)) {
    const marginX = Math.min(MARGIN, Math.max(0, Math.floor((area.width - 1) / 2)));
    const marginY = Math.min(MARGIN, Math.max(0, Math.floor((area.height - 1) / 2)));
    const width = Math.max(1, Math.min(Math.round(rect.width), area.width - marginX * 2));
    const height = Math.max(1, Math.min(Math.round(rect.height), area.height - marginY * 2));
    return {
      x: Math.round(Math.max(area.x + marginX, Math.min(rect.x, area.x + area.width - marginX - width))),
      y: Math.round(Math.max(area.y + marginY, Math.min(rect.y, area.y + area.height - marginY - height))),
      width, height,
    };
  }

  function clampPanel(rect, area = workArea(rect)) {
    return clamp({ ...rect,
      width: Math.max(PANEL_WIDTH, Math.min(PANEL_MAX_WIDTH, rect.width)),
      height: Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, rect.height)),
    }, area);
  }

  function getState() {
    return {
      visible: alive(panel) && panel.isVisible(),
      requestedVisible: panelWanted,
      pinned,
      orbVisible: alive(orb) && orb.isVisible(),
      enabled: isQuickChatEnabled(settings),
      orbEnabled: isQuickChatEnabled(settings),
      orbHiddenForSession,
      bounds: alive(panel) ? panel.getBounds() : null,
    };
  }

  function notify() {
    if (disposed) return;
    const state = getState();
    for (const win of [panel, orb]) {
      if (alive(win) && !win.webContents.isDestroyed()) win.webContents.send('mini:window-state', state);
    }
    onStateChange(state);
  }

  function writePatch(patch) {
    // Read immediately before writing: provider, theme and other preferences may
    // have changed while the window was moving.
    const latest = readSettings() || {};
    if (Object.keys(patch).some(key => JSON.stringify(latest[key]) !== JSON.stringify(patch[key]))) {
      try { writeSettings({ ...latest, ...patch }); }
      catch (error) { onError(error); return false; }
    }
    settings = { ...latest, ...patch };
    return true;
  }

  function persistBounds() {
    if (persistTimer != null) timers.clearTimeout(persistTimer);
    persistTimer = null;
    if (disposed) return;
    const patch = {};
    if (alive(panel)) patch.miniWindowBounds = panel.getBounds();
    if (alive(orb)) {
      const { x, y } = orb.getBounds();
      patch.floatingOrbPosition = { x, y };
    }
    if (Object.keys(patch).length) writePatch(patch);
  }

  function queuePersistence() {
    if (disposed || animation) return;
    if (persistTimer != null) timers.clearTimeout(persistTimer);
    persistTimer = timers.setTimeout(persistBounds, 150);
    persistTimer?.unref?.();
  }

  function cancelAnimation() {
    if (!animation) return;
    timers.clearTimeout(animation.timer);
    animation = null;
  }

  function baseWindow(kind, bounds) {
    const win = new BrowserWindow({
      ...bounds,
      frame: false, transparent: true, resizable: false, movable: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: kind === 'orb' || pinned,
      show: false, hasShadow: false,
      ...(kind === 'orb' ? { focusable: false } : {}),
      webPreferences: {
        preload: path.join(rootDir, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, spellcheck: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const preventNavigation = event => event.preventDefault();
    win.webContents.on('will-navigate', preventNavigation);
    win.webContents.on('will-frame-navigate', preventNavigation);
    win.webContents.on('will-attach-webview', preventNavigation);
    win.setVisibleOnAllWorkspaces?.(true);
    win.on('move', queuePersistence);
    win.on('resize', queuePersistence);
    win.on('will-move', () => { if (kind === 'panel') cancelAnimation(); });
    win.on('close', event => {
      if (disposed) return;
      event.preventDefault();
      if (kind === 'orb') hideOrbForSession(); else hide();
    });
    win.webContents.on('did-finish-load', notify);
    return win;
  }

  function initialPanelBounds(source) {
    if (safeBounds(settings.miniWindowBounds)) {
      const restored = { ...settings.miniWindowBounds };
      // The old panel had a fixed 520px width and 270px compact height. Upgrade
      // those defaults once on creation; ordinary live resizing keeps its size.
      if (restored.width === 520) restored.width = PANEL_WIDTH;
      if (restored.height === 270) restored.height = PANEL_MIN_HEIGHT;
      return clampPanel(restored);
    }
    const area = source === 'orb' && alive(orb) ? workArea(orb.getBounds()) : workArea();
    const bounds = {
      width: PANEL_WIDTH, height: PANEL_MIN_HEIGHT,
      x: area.x + (area.width - PANEL_WIDTH) / 2,
      y: area.y + area.height * 0.28,
    };
    if (source === 'orb' && alive(orb)) {
      const anchor = orb.getBounds();
      bounds.x = anchor.x - PANEL_WIDTH - MARGIN;
      if (bounds.x < area.x + MARGIN) bounds.x = anchor.x + anchor.width + MARGIN;
      bounds.y = anchor.y + (anchor.height - PANEL_MIN_HEIGHT) / 2;
    }
    return clampPanel(bounds, area);
  }

  function revealPanel() {
    if (disposed || !panelWanted || !panelReady || !alive(panel)) return;
    panel.show();
    panel.focus();
    panel.webContents.send('mini:focus');
    notify();
  }

  function ensurePanel(source) {
    if (alive(panel)) return panel;
    panelReady = false;
    const win = panel = baseWindow('panel', initialPanelBounds(source));
    win.once('ready-to-show', () => { if (panel === win) { panelReady = true; revealPanel(); } });
    win.on('closed', () => {
      if (panel !== win) return;
      cancelAnimation(); panel = null; panelReady = false; panelWanted = false; notify();
    });
    win.loadFile(path.join(rootDir, 'renderer', 'mini.html'));
    return win;
  }

  function revealOrb() {
    if (disposed || !orbReady || !alive(orb)) return;
    if (!isQuickChatEnabled(settings) || orbHiddenForSession) orb.hide();
    else orb.showInactive();
    notify();
  }

  function ensureOrb() {
    if (alive(orb)) return orb;
    const position = settings.floatingOrbPosition;
    const area = safePosition(position) ? workArea({ ...position, width: ORB_SIZE, height: ORB_SIZE }) : workArea();
    const bounds = clamp({ width: ORB_SIZE, height: ORB_SIZE,
      x: safePosition(position) ? position.x : area.x + area.width - ORB_SIZE - 24,
      y: safePosition(position) ? position.y : area.y + area.height * 0.62,
    }, area);
    orbReady = false;
    const win = orb = baseWindow('orb', bounds);
    win.once('ready-to-show', () => { if (orb === win) { orbReady = true; revealOrb(); } });
    win.on('closed', () => { if (orb === win) { orb = null; orbReady = false; drag = null; notify(); } });
    win.loadFile(path.join(rootDir, 'renderer', 'floating-orb.html'));
    return win;
  }

  function releaseOrb() {
    if (!alive(orb)) return;
    // Persist before detaching so a later explicit show restores the same spot.
    // The orb holds no chat state; hidden panels and their sessions stay alive.
    persistBounds();
    const win = orb;
    orb = null; orbReady = false; drag = null;
    win.destroy();
  }

  function syncSettings() {
    if (disposed) return getState();
    settings = readSettings() || {};
    pinned = settings.miniWindowPinned !== false;
    if (alive(panel)) panel.setAlwaysOnTop(pinned);
    if (animation && (settings.reduceMotion === true || options.reduceMotion === true)) {
      resize(animation.target.height, { reduceMotion: true });
    }
    if (!isQuickChatEnabled(settings)) releaseOrb();
    else if (started && !orbHiddenForSession) ensureOrb();
    revealOrb();
    if (!isQuickChatEnabled(settings)) hide();
    notify();
    return getState();
  }

  function permitted() {
    return !disposed && isQuickChatEnabled(settings);
  }

  function show(input = {}) {
    const source = input.source || 'manual';
    if (!permitted(source)) return { ok: false, ...getState() };
    panelWanted = true;
    ensurePanel(source);
    revealPanel();
    return { ok: true, ...getState() };
  }

  function hide() {
    if (disposed) return { ok: false, ...getState() };
    panelWanted = false;
    cancelAnimation();
    if (alive(panel)) panel.hide();
    persistBounds(); notify();
    return { ok: true, ...getState() };
  }

  function toggle(input = {}) {
    if (!permitted(input.source || 'manual')) return { ok: false, ...getState() };
    return panelWanted || (alive(panel) && panel.isVisible()) ? hide() : show(input);
  }

  function resize(height, input = {}) {
    if (disposed || !alive(panel) || !finite(height)) return { ok: false };
    const current = panel.getBounds();
    const area = workArea(current);
    const target = clampPanel({ ...current, height: Math.round(height) }, area);
    const reducedMotion = input.reduceMotion === true || input.reducedMotion === true
      || options.reduceMotion === true || settings.reduceMotion === true;
    if (reducedMotion || !panel.isVisible()) {
      const changed = Object.keys(target).some(key => target[key] !== current[key]);
      const finishing = !!animation;
      cancelAnimation();
      if (changed) panel.setBounds(target);
      // A same-size layout request is a no-op, including while hidden. Avoid
      // a window-state -> renderer layout -> resize -> window-state loop.
      if (changed || finishing) { persistBounds(); notify(); }
      return { ok: true, bounds: target };
    }
    if (animation && animation.target.height === target.height && animation.target.y === target.y) {
      return { ok: true, bounds: animation.target };
    }
    if (animation) {
      // Streaming tokens may revise the target every frame. Keep the spring's
      // fractional position, velocity and next frame; a new ease-out from the
      // rounded native bounds would repeatedly jump and lose its momentum.
      animation.target = target;
      animation.area = area;
      return { ok: true, bounds: target };
    }
    if (Object.keys(target).every(key => target[key] === current[key])) return { ok: true, bounds: target };
    // A move queued before the animation must not persist an intermediate size.
    if (persistTimer != null) timers.clearTimeout(persistTimer);
    persistTimer = null;
    const transition = animation = { target, area, timer: null, at: timers.now(),
      position: { ...current }, velocity: { x: 0, y: 0, width: 0, height: 0 } };
    const step = () => {
      if (disposed || animation !== transition || !alive(panel)) return;
      const now = timers.now();
      // Native window operations can briefly block the main loop. Do not turn
      // that missed wall time into a single visible leap when rendering resumes.
      const dt = Math.min(MAX_FRAME_ADVANCE_MS, Math.max(0, now - transition.at)) / 1000;
      transition.at = now;
      const decay = Math.exp(-SPRING_FREQUENCY * dt);
      let settled = true;
      for (const key of ['x', 'y', 'width', 'height']) {
        const error = transition.position[key] - transition.target[key];
        let velocity = transition.velocity[key];
        // Retain velocity for continued growth. A reversed or much nearer
        // target needs braking so neither contraction nor expansion overshoots.
        if (error === 0 || velocity * error > 0) velocity = 0;
        else velocity = Math.sign(velocity) * Math.min(Math.abs(velocity), SPRING_FREQUENCY * Math.abs(error));
        const coefficient = velocity + SPRING_FREQUENCY * error;
        transition.position[key] = transition.target[key] + (error + coefficient * dt) * decay;
        transition.velocity[key] = (velocity - SPRING_FREQUENCY * coefficient * dt) * decay;
        if (Math.abs(transition.position[key] - transition.target[key]) > 0.5
          || Math.abs(transition.velocity[key]) > 12) settled = false;
      }
      // Interpolated height and top offsets can have different velocities near
      // the screen edge. Clamp every native frame, including during retargets.
      const bounds = settled ? transition.target : clamp(transition.position, transition.area);
      for (const key of ['x', 'y', 'width', 'height']) {
        if (Math.abs(bounds[key] - transition.position[key]) > 0.5) {
          transition.position[key] = bounds[key]; transition.velocity[key] = 0;
        }
      }
      panel.setBounds(bounds);
      if (settled) {
        animation = null; persistBounds(); notify();
      } else {
        transition.timer = timers.setTimeout(step, FRAME_MS);
        transition.timer?.unref?.();
      }
    };
    transition.timer = timers.setTimeout(step, FRAME_MS);
    transition.timer?.unref?.();
    return { ok: true, bounds: target };
  }

  function setPinned(value) {
    if (disposed || typeof value !== 'boolean') return { ok: false };
    pinned = value;
    if (alive(panel)) panel.setAlwaysOnTop(pinned);
    const saved = writePatch({ miniWindowPinned: pinned }); notify();
    return { ok: saved, ...getState() };
  }

  function orbDrag(input = {}) {
    if (disposed || !alive(orb) || !orb.isVisible()) return { ok: false };
    if (input.phase === 'start') {
      drag = { point: screen.getCursorScreenPoint(), bounds: orb.getBounds(), moved: false };
      return { ok: true, moved: false };
    }
    if (!drag || !['move', 'end', 'cancel'].includes(input.phase)) return { ok: false };
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - drag.point.x, dy = cursor.y - drag.point.y;
    drag.moved ||= Math.hypot(dx, dy) >= 4;
    if (drag.moved) orb.setBounds(clamp({ ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy }));
    const result = { ok: true, moved: drag.moved, bounds: orb.getBounds() };
    if (input.phase !== 'move') { drag = null; persistBounds(); }
    return result;
  }

  function hideOrbForSession() {
    if (disposed) return { ok: false };
    orbHiddenForSession = true; drag = null;
    releaseOrb(); notify();
    return { ok: true };
  }

  function showOrb() {
    if (disposed || !isQuickChatEnabled(settings)) return { ok: false };
    orbHiddenForSession = false;
    ensureOrb(); revealOrb();
    return { ok: true, ...getState() };
  }

  function showContextMenu() {
    if (disposed || !alive(orb) || !Menu?.buildFromTemplate) return { ok: false };
    const menu = Menu.buildFromTemplate([
      { label: '打开快捷对话', click: () => show({ source: 'orb' }) },
      { label: '打开 Relay', click: () => onOpenMain() },
      { type: 'separator' },
      { label: '本次隐藏悬浮球', click: hideOrbForSession },
      { label: '关闭悬浮球与快捷小窗', click: () => {
        if (writePatch(normalizeQuickChatPatch({ quickChatEnabled: false }))) { syncSettings(); onDisableOrb(); }
      } },
    ]);
    menu.popup({ window: orb });
    return { ok: true };
  }

  function clampWindows() {
    if (disposed) return;
    cancelAnimation(); drag = null;
    for (const win of [panel, orb]) if (alive(win)) {
      const bounds = win.getBounds();
      win.setBounds(win === panel ? clampPanel(bounds) : clamp(bounds));
    }
    persistBounds(); notify();
  }

  function start() {
    if (disposed || started) return getState();
    started = true;
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, clampWindows);
    return syncSettings();
  }

  function destroy() {
    if (disposed) return;
    persistBounds();
    disposed = true; panelWanted = false; drag = null;
    cancelAnimation();
    if (persistTimer != null) timers.clearTimeout(persistTimer);
    persistTimer = null;
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, clampWindows);
    for (const win of [panel, orb]) if (alive(win)) win.destroy();
    panel = null; orb = null;
  }

  return { start, syncSettings, show, toggle, hide, resize, setPinned, getState,
    getPanelWindow: () => alive(panel) ? panel : null,
    getOrbWindow: () => alive(orb) ? orb : null,
    isPanelSender: contents => alive(panel) && panel.webContents === contents,
    ownsWebContents: contents => [panel, orb].some(win => alive(win) && win.webContents === contents),
    orbDrag, showContextMenu, hideOrbForSession, showOrb, destroy };
}

module.exports = { createMiniWindowHost, isQuickChatEnabled, normalizeQuickChatPatch };
