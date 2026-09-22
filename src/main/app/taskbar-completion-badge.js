'use strict';

const fs = require('node:fs');
const path = require('node:path');
const TASKBAR_FRAME_SIZES = Object.freeze([
  16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 80, 96, 112, 128,
]);

// Native Windows calls retain the physical DPI frame. Electron's fallback API
// always rasterizes overlays to 16px, even when NativeImage has DPI variants.
function createNativeTaskbarOverlay({
  assetDirectory, onError = () => {}, platform = process.platform, arch = process.arch,
  loadNative = file => require(file),
}) {
  let native, attempted = false;
  const frames = new Map();
  return (win, count, description) => {
    if (platform !== 'win32' || arch !== 'x64' || !win?.getNativeWindowHandle) return false;
    try {
      if (!attempted) {
        attempted = true;
        native = loadNative(path.join(assetDirectory, 'native', 'win32-x64.node'));
      }
      if (!native) return false;
      const handle = win.getNativeWindowHandle();
      const wanted = native.getOverlaySize(handle);
      const size = TASKBAR_FRAME_SIZES.find(size => size >= wanted) || TASKBAR_FRAME_SIZES.at(-1);
      let frame = Buffer.alloc(0);
      if (count) {
        const name = count > 9 ? '9-plus' : String(count);
        const suffix = size === 16 ? '' : '@' + size / 16 + 'x';
        const file = path.join(assetDirectory, name + suffix + '.png');
        if (!frames.has(file)) frames.set(file, fs.readFileSync(file));
        frame = frames.get(file);
      }
      native.setOverlayIcon(handle, frame, description);
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };
}


// Only authoritative parent-run terminal transitions create reminders. SDK
// result frames, title inference, pauses and startup recovery are not completions.
function createTaskbarCompletionBadge({ getWindow, imageForCount, setOverlay, isForeground = () => false, onError = () => {} }) {
  const unread = new Map(), seen = new Set();
  let watchedWindow = null, repaintPending = false, disposed = false;
  function queueRepaint() {
    if (disposed || repaintPending || !unread.size) return;
    repaintPending = true;
    setImmediate(() => { repaintPending = false; if (unread.size) refresh(); });
  }
  function detachWindow() {
    if (watchedWindow && !watchedWindow.isDestroyed()) {
      watchedWindow.removeListener?.('moved', queueRepaint);
      watchedWindow.removeListener?.('show', queueRepaint);
      watchedWindow.unhookWindowMessage?.(0x02e0);
    }
    watchedWindow = null;
  }
  function watchWindow(win) {
    if (watchedWindow === win) return;
    detachWindow();
    watchedWindow = win;
    // WM_DPICHANGED arrives before Electron finishes updating window metrics.
    // Repaint on the next turn so getOverlaySize reads the destination DPI.
    win.on?.('moved', queueRepaint);
    win.on?.('show', queueRepaint);
    win.hookWindowMessage?.(0x02e0, queueRepaint);
  }
  function refresh() {
    if (disposed) return;
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    try {
      watchWindow(win);
      const count = unread.size;
      const description = count ? `${count} 个后台任务已结束` : '';
      let handled = false;
      try { handled = setOverlay?.(win, count, description) === true; }
      catch (error) { onError(error); }
      if (!handled) win.setOverlayIcon(count ? imageForCount(count) : null, description);
    } catch (error) { onError(error); }
  }
  function observe(change) {
    if (disposed) return;
    const { run, previous } = change || {};
    if (!run || !previous || !['succeeded', 'failed'].includes(run.state)
        || ['succeeded', 'failed', 'canceled', 'interrupted'].includes(previous.state)
        || !['conversation', 'mini', 'creation', 'schedule'].includes(run.source?.type)
        || run.lineage?.parentRunId || !run.runId || seen.has(run.runId)) return;
    seen.add(run.runId);
    if (seen.size > 4096) seen.delete(seen.values().next().value);
    if (isForeground(run)) return;
    unread.set(run.runId, run.source.conversationId || null);
    refresh();
  }
  function clear() { if (unread.size) { unread.clear(); refresh(); } }
  function clearConversation(id) {
    if (!id) return;
    let changed = false;
    for (const [runId, conversationId] of unread) if (conversationId === id) { unread.delete(runId); changed = true; }
    if (changed) refresh();
  }
  return { observe, refresh, clear, clearConversation, count: () => unread.size,
    dispose: () => { disposed = true; unread.clear(); seen.clear(); detachWindow(); } };
}

module.exports = { createTaskbarCompletionBadge, createNativeTaskbarOverlay, TASKBAR_FRAME_SIZES };
