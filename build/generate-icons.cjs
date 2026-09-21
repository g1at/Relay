'use strict';

// Run with Electron from the repository root. All default artwork is derived
// from the approved transparent master, with separate dark-background colors.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ICON_SIZES: sizes, NATIVE_SAMPLE_FACTOR, createDefaultLogoAssets, createNativeIconAssets, encodeIco, downsampleRgba } = require('./logo-assets.cjs');
const root = path.resolve(__dirname, '..');
const nativeOnly = process.argv.includes('--native-only');
const outputArgument = process.argv.find(value => value.startsWith('--output-dir='));
const outputRoot = outputArgument ? path.resolve(outputArgument.slice('--output-dir='.length)) : root;
app.setPath('userData', path.join(root, '.codex-tmp', 'icon-generation-profile'));
app.commandLine.appendSwitch('disable-gpu');
const deadline = setTimeout(() => app.exit(1), 30000);

app.whenReady().then(async () => {
  const masterFile = path.join(root, 'design', 'relay-logo', 'relay-dual-gate-master.svg');
  if (!fs.existsSync(masterFile)) {
    throw new Error('图标重新生成需要本地设计母版 design/relay-logo/relay-dual-gate-master.svg；design/ 不随源码发布。正常运行和默认打包使用已提交的图标，无需运行此生成脚本。');
  }
  const master = fs.readFileSync(masterFile, 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  await win.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:">');
  const assets = createDefaultLogoAssets(master);
  const nativeAssets = createNativeIconAssets(master);
  async function rasterize(svg, dimensions, sampleFactor = 1) {
    const data = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
      await img.decode();
      const sampleFactor = ${sampleFactor};
      const downsample = ${downsampleRgba.toString()};
      return ${JSON.stringify(dimensions)}.map(size => {
        const sampled = document.createElement('canvas');
        sampled.width = sampled.height = size * sampleFactor;
        const sampledContext = sampled.getContext('2d', { willReadFrequently: true });
        sampledContext.drawImage(img, 0, 0, sampled.width, sampled.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const source = sampledContext.getImageData(0, 0, sampled.width, sampled.height).data;
        ctx.putImageData(new ImageData(downsample(source, size, sampleFactor), size, size), 0, 0);
        return canvas.toDataURL('image/png').split(',')[1];
      });
    })()`);
    return data.map(value => Buffer.from(value, 'base64'));
  }
  const rasterized = [];
  for (const suffix of ['', '-dark']) {
    const [png] = nativeOnly ? [] : await rasterize(assets[`logo-app${suffix}.svg`], [256], NATIVE_SAMPLE_FACTOR);
    const frames = await rasterize(nativeAssets[`icon${suffix}.svg`], sizes, NATIVE_SAMPLE_FACTOR);
    rasterized.push({ suffix, png, ico: encodeIco(frames) });
  }
  fs.mkdirSync(path.join(outputRoot, 'build'), { recursive: true });
  if (!nativeOnly) {
    fs.mkdirSync(path.join(outputRoot, 'renderer'), { recursive: true });
    for (const [name, svg] of Object.entries(assets)) fs.writeFileSync(path.join(outputRoot, 'renderer', name), svg);
  }
  for (const { suffix, png, ico } of rasterized) {
    if (png) fs.writeFileSync(path.join(outputRoot, 'renderer', `logo${suffix}.png`), png);
    fs.writeFileSync(path.join(outputRoot, 'build', `icon${suffix}.ico`), ico);
  }
  console.log(`Generated ${nativeOnly ? 'native icons' : 'default artwork'} with ${NATIVE_SAMPLE_FACTOR}x coverage sampling: ` + sizes.join(', '));
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
