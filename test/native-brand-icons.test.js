'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDefaultLogoAssets, createNativeIconAssets } = require('../build/logo-assets.cjs');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const start = source.indexOf('function resolveNativeIcon(');
const end = source.indexOf('// ── 系统托盘', start);
const masterFile = path.join(__dirname, '../design/relay-logo/relay-dual-gate-master.svg');
const runtimeLogo = fs.readFileSync(path.join(__dirname, '../renderer/logo.svg'), 'utf8');

test('native icons enlarge the runtime artwork while renderer branding keeps its existing viewport', () => {
  const renderer = createDefaultLogoAssets(runtimeLogo);
  const native = createNativeIconAssets(runtimeLogo);
  for (const suffix of ['', '-dark']) {
    const nativeSvg = native[`icon${suffix}.svg`];
    assert.equal(nativeSvg.replace('viewBox="144 144 736 736"', 'viewBox="0 0 1024 1024"'),
      renderer[`logo${suffix}.svg`], 'native export preserves every path, transform and theme color');
    assert.match(renderer[`logo-app${suffix}.svg`], /viewBox="48 48 928 928"/);
    assert.equal(fs.readFileSync(path.join(__dirname, '../renderer', `logo-app${suffix}.svg`), 'utf8'),
      renderer[`logo-app${suffix}.svg`], 'the renderer asset remains unchanged');
  }
  assert.throws(() => createNativeIconAssets('<svg/>'), /unexpected viewBox or palette/);
});

test('native icon generation retains the local approved design master', {
  skip: fs.existsSync(masterFile) ? false : 'Local design/ master is not included in the source checkout.',
}, () => {
  assert.deepEqual(createNativeIconAssets(fs.readFileSync(masterFile, 'utf8')), createNativeIconAssets(runtimeLogo));
});

function fixture({ dark = false, theme = 'system', packaged = false, missingDark = false } = {}) {
  const calls = [], nativeTheme = { themeSource: theme, shouldUseDarkColors: dark, shouldUseDarkColorsForSystemIntegratedUI: dark };
  const context = vm.createContext({ path, __dirname: '/fixture/relay',
    app: { isPackaged: packaged }, process: { resourcesPath: '/fixture/resources' },
    require: name => { assert.equal(name, './native-brand-theme'); return require('../native-brand-theme'); },
    fs: { existsSync: file => !missingDark || !file.endsWith('icon-dark.ico') }, nativeTheme,
    nativeImage: { createFromPath: file => ({ file, isEmpty: () => false }) },
    tray: { isDestroyed: () => false, setImage: image => calls.push(['tray', image.file]) },
    BrowserWindow: { getAllWindows: () => [
      { isDestroyed: () => false, setIcon: file => calls.push(['window', file]) },
      { isDestroyed: () => true, setIcon: () => assert.fail('Destroyed windows must be skipped') },
    ] }, console: { warn() {} },
  });
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  return { calls, nativeTheme, icon: () => context.currentAppIcon(), refresh: () => context.refreshNativeBrandIcons() };
}

test('native transparent artwork switches palettes when the operating-system theme changes', () => {
  const h = fixture();
  assert.ok(h.icon().endsWith(path.join('build', 'icon.ico')));
  h.nativeTheme.shouldUseDarkColors = true;
  h.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true;
  h.refresh();
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(([, file]) => file.endsWith(path.join('build', 'icon-dark.ico'))));
  h.nativeTheme.shouldUseDarkColors = false;
  h.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = false;
  h.refresh();
  assert.ok(h.calls.slice(2).every(([, file]) => file.endsWith(path.join('build', 'icon.ico'))));
});

test('manual Relay light and dark modes retain the master native icon regardless of OS theme', () => {
  for (const theme of ['light', 'dark']) for (const dark of [false, true]) {
    const h = fixture({ theme, dark });
    assert.ok(h.icon().endsWith(path.join('build', 'icon.ico')));
    h.refresh(); assert.ok(h.calls.every(([, file]) => file.endsWith(path.join('build', 'icon.ico'))));
  }
});

test('system mode with dark apps but a light Windows taskbar never uses white artwork', () => {
  const h = fixture({ dark: true }); h.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = false;
  assert.ok(h.icon().endsWith(path.join('build', 'icon.ico')));
});

test('packaged icons resolve outside asar, with the light master as a missing-dark fallback', () => {
  assert.equal(fixture({ dark: true, packaged: true }).icon(), path.join('/fixture/resources', 'icon-dark.ico'));
  assert.equal(fixture({ dark: true, packaged: true, missingDark: true }).icon(), path.join('/fixture/resources', 'icon.ico'));
});

test('the packaged native theme listener is removed during shutdown', () => {
  assert.match(source, /nativeTheme\.on\('updated', updateNativeBrandTheme\)/);
  assert.match(source, /nativeTheme\.removeListener\('updated', updateNativeBrandTheme\)/);
  assert.match(source, /nativeBrandTheme\.dispose\(\)/);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(config.build.extraResources.some(item => item.from === 'build/icon-dark.ico' && item.to === 'icon-dark.ico'));
  assert.ok(config.build.files.includes('native-brand-theme.js'));
});
