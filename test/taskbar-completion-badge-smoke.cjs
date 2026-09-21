'use strict';
// Isolated native window, local artwork, synthetic terminal transitions only.
const { app, BrowserWindow, nativeImage, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { createTaskbarCompletionBadge, createNativeTaskbarOverlay, TASKBAR_FRAME_SIZES } = require('../taskbar-completion-badge');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/taskbar-completion-badge-smoke');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile'));
app.setAppUserModelId('relay.fixture.taskbar-completion-badge');
app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('disable-gpu');
const report = { checks: {}, errors: [], nativeCalls: [], fallbackCalls: [] }; let win, badge;
function check(name, value) {
  report.checks[name] = !!value;
  if (!value) throw Error(name);
  console.log(name + ': true');
}
const timeout = setTimeout(() => finish(1), 20000);
function finish(code) {
  clearTimeout(timeout);
  badge?.dispose();
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(code);
}
app.whenReady().then(async () => {
  const directory = path.join(root, 'renderer/taskbar-badges');
  win = new BrowserWindow({ width: 420, height: 180, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const { BADGE_SIZES, BADGES } = require('../build/taskbar-badge-assets.cjs');
  check('EveryDpiFrameDecodesAtItsExactNativeSize', BADGES.every(({ name }) => {
    const bytes = fs.readFileSync(path.join(directory, name + '.ico'));
    return bytes.readUInt16LE(4) === BADGE_SIZES.length && BADGE_SIZES.every((size, index) => {
      const entry = 6 + index * 16, length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
      const frame = nativeImage.createFromBuffer(bytes.subarray(offset, offset + length));
      return !frame.isEmpty() && frame.getSize().width === size && frame.getSize().height === size && frame.getBitmap()[3] === 0;
    });
  }));
  check('NumeralOneKeepsOpaqueWhitePixelAlignedStemAtEveryDpi', TASKBAR_FRAME_SIZES.every(size => {
    const suffix = size === 16 ? '' : '@' + size / 16 + 'x';
    // Buffer loading bypasses filename scale-factor interpretation.
    const bitmap = nativeImage.createFromBuffer(fs.readFileSync(path.join(directory, '1' + suffix + '.png'))).getBitmap();
    const stem = Math.max(2, Math.round(size / 8)), shoulder = stem;
    const left = Math.round((size - stem + shoulder) / 2), y = Math.round(size / 2);
    for (let x = left; x < left + stem; x++) {
      const offset = (y * size + x) * 4;
      if (![0, 1, 2, 3].every(channel => bitmap[offset + channel] === 255)) return false;
    }
    return true;
  }));
  const addon = require(path.join(directory, 'native', 'win32-x64.node'));
  let invalidWindowRejected = false;
  try { addon.getOverlaySize(Buffer.alloc(8)); } catch { invalidWindowRejected = true; }
  check('NativeBridgeRejectsInvalidWindowHandles', invalidWindowRejected);
  const handle = win.getNativeWindowHandle();
  let malformedRejected = false;
  try { addon.setOverlayIcon(handle, Buffer.from('not-png'), 'invalid fixture'); } catch { malformedRejected = true; }
  check('NativeBridgeRejectsMalformedArtwork', malformedRejected);
  const setter = createNativeTaskbarOverlay({ assetDirectory: directory,
    onError: error => report.errors.push(String(error)),
    loadNative: () => ({
      getOverlaySize: value => addon.getOverlaySize(value),
      setOverlayIcon: (value, frame, description) => {
        const hiconWidth = addon.setOverlayIcon(value, frame, description);
        report.nativeCalls.push({ pngWidth: frame.length ? frame.readUInt32BE(16) : 0, hiconWidth, description });
      },
    }) });
  const set = win.setOverlayIcon.bind(win);
  win.setOverlayIcon = (icon, description) => {
    set(icon, description);
    report.fallbackCalls.push({ size: icon?.getSize() || null, description });
  };
  badge = createTaskbarCompletionBadge({ getWindow: () => win, setOverlay: setter,
    imageForCount: count => nativeImage.createFromPath(path.join(directory, (count > 9 ? '9-plus' : count) + '.png')),
    onError: error => report.errors.push(String(error)) });
  const end = i => badge.observe({ previous: { state: 'running' },
    run: { runId: String(i), state: 'succeeded', source: { type: 'conversation', conversationId: 'fixture-' + i } } });
  await win.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:"><title>Relay badge fixture</title>');
  win.showInactive();
  const wanted = addon.getOverlaySize(handle);
  const expectedSize = TASKBAR_FRAME_SIZES.find(size => size >= wanted) || TASKBAR_FRAME_SIZES.at(-1);
  report.display = { scaleFactor: screen.getDisplayMatching(win.getBounds()).scaleFactor, physicalOverlaySize: wanted };
  end(1);
  check('NativeWindowsOverlayUsesPhysicalDpiHiconInsteadOfFixed16px',
    badge.count() === 1 && report.nativeCalls.at(-1).hiconWidth === expectedSize &&
    report.nativeCalls.at(-1).pngWidth === expectedSize && report.fallbackCalls.length === 0);
  // Test HICON construction at every available scale, even on a single-DPI host.
  check('NativeHiconRetainsEachIndependentDpiFrame', TASKBAR_FRAME_SIZES.every(size => {
    const suffix = size === 16 ? '' : '@' + size / 16 + 'x';
    return addon.setOverlayIcon(handle, fs.readFileSync(path.join(directory, '1' + suffix + '.png')), 'Synthetic DPI fixture') === size;
  }));
  badge.refresh();
  for (let i = 2; i <= 12; i++) end(i);
  check('ManyCompletionsUseBoundedArtworkAndExactAccessibleCount',
    badge.count() === 12 && report.nativeCalls.at(-1).description === '12 个后台任务已结束' &&
    report.nativeCalls.at(-1).hiconWidth === expectedSize);
  badge.clear();
  check('AcknowledgingRemovesTheNativeOverlay',
    report.nativeCalls.at(-1).hiconWidth === 0 && report.nativeCalls.at(-1).description === '');
  end(1);
  check('RepeatedDeliveryAfterAcknowledgingDoesNotRecreateReminder', badge.count() === 0);
  check('NoNativeOverlayErrorsOrFallback', report.errors.length === 0 && report.fallbackCalls.length === 0);
  // Synthetic before/after proof of the pixels submitted at 200% scaling.
  const small = fs.readFileSync(path.join(directory, '1.png')).toString('base64');
  const exact = fs.readFileSync(path.join(directory, '1@2x.png')).toString('base64');
  const png = await win.webContents.executeJavaScript(
    '(async () => { const images = await Promise.all(' + JSON.stringify([small, exact]) + '.map(data => new Promise(resolve => {' +
    'const image = new Image(); image.onload = () => resolve(image); image.src = "data:image/png;base64," + data; })));' +
    'const canvas = document.createElement("canvas"); canvas.width = 300; canvas.height = 104; const ctx = canvas.getContext("2d");' +
    'ctx.fillStyle="#efe1d9";ctx.fillRect(0,0,300,104);ctx.fillStyle="#252529";ctx.font="13px Segoe UI";' +
    'ctx.fillText("16px scaled to 32px",10,22);ctx.fillText("Native 32px frame",164,22);' +
    'ctx.drawImage(images[0],56,46,32,32);ctx.drawImage(images[1],212,46,32,32);return canvas.toDataURL("image/png").split(",")[1];})()');
  fs.writeFileSync(path.join(out, 'dpi-comparison.png'), Buffer.from(png, 'base64'));
  check('SyntheticDpiComparisonArtifactWritten', true);
  // Exercise the production loader through an ASAR and its unpacked native file.
  const asar = require('@electron/asar'), fixture = path.join(out, 'asar-fixture');
  const source = path.join(fixture, 'source'), nativeDir = path.join(source, 'renderer/taskbar-badges/native');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.copyFileSync(path.join(directory, 'native/win32-x64.node'), path.join(nativeDir, 'win32-x64.node'));
  fs.copyFileSync(path.join(root, 'taskbar-completion-badge.js'), path.join(source, 'taskbar-completion-badge.js'));
  const suffix = expectedSize === 16 ? '' : '@' + expectedSize / 16 + 'x';
  fs.copyFileSync(path.join(directory, '1' + suffix + '.png'),
    path.join(source, 'renderer/taskbar-badges', '1' + suffix + '.png'));
  const archive = path.join(fixture, 'app.asar');
  // @electron/asar matches absolute filenames; electron-builder's asarUnpack
  // rules are project-relative and are covered by the packaging unit test.
  await asar.createPackageWithOptions(source, archive, { unpack: '*.node' });
  const packedModule = require(path.join(archive, 'taskbar-completion-badge.js'));
  const packedErrors = [];
  const packedSetter = packedModule.createNativeTaskbarOverlay({
    assetDirectory: path.join(archive, 'renderer/taskbar-badges'), onError: error => packedErrors.push(String(error)),
  });
  check('PackagedAsarLoadsNativeAddonAndReadsPackedDpiFrame',
    fs.existsSync(archive + '.unpacked/renderer/taskbar-badges/native/win32-x64.node') &&
    packedSetter(win, 1, 'Packaged synthetic fixture') === true && packedSetter(win, 0, '') === true &&
    packedErrors.length === 0);
  finish(0);
}).catch(error => { report.errors.push(String(error.stack || error)); finish(1); });
