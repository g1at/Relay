'use strict';

// Run with Electron from the repository root. These small count overlays are
// independent of the Relay brand icon and use an isolated generation profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { BADGES: badges, BADGE_SIZES: sizes, encodeBadgeIco } = require('./taskbar-badge-assets.cjs');
const root = path.resolve(__dirname, '..');

app.setPath('userData', path.join(root, '.codex-tmp', 'taskbar-badge-generation-profile'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-networking');
const deadline = setTimeout(() => app.exit(1), 30000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  await win.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27">');
  const rasterized = await win.webContents.executeJavaScript(`(() => {
    return ${JSON.stringify(badges)}.map(({ name, label }) => {
      const frames = ${JSON.stringify(sizes)}.map(size => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Draw at the actual target resolution so small numerals retain the font
        // rasterizer's pixel hinting. Supersampling then shell scaling blurred it.
        ctx.fillStyle = '#17191D';
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size * 15 / 32, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '700 ' + Math.round(size * (label.length > 1 ? .56 : .75)) + 'px "Segoe UI", system-ui, sans-serif';
        ctx.textBaseline = 'alphabetic';
        const metrics = ctx.measureText(label);
        // Center the visible glyph, including the asymmetric bearings of "1".
        const x = Math.round(size / 2 - (metrics.actualBoundingBoxRight - metrics.actualBoundingBoxLeft) / 2);
        const y = Math.round(size / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
        if (label === '1') {
          // Segoe UI's tiny "1" can put the entire vertical stem between pixel
          // columns. Use its simple stem/shoulder silhouette on the pixel grid.
          const stem = Math.max(2, Math.round(size / 8));
          const height = Math.round(size * .625), top = Math.round((size - height) / 2);
          const shoulder = Math.max(2, Math.round(size / 8));
          const left = Math.round((size - stem + shoulder) / 2);
          ctx.fillRect(left, top, stem, height);
          ctx.beginPath();
          ctx.moveTo(left, top); ctx.lineTo(left - shoulder, top + shoulder);
          ctx.lineTo(left - shoulder, top + shoulder + stem); ctx.lineTo(left, top + stem);
          ctx.closePath(); ctx.fill();
        } else ctx.fillText(label, x, y);

        return canvas.toDataURL('image/png').split(',')[1];
      });
      return { name, label, frames };
    });
  })()`);

  const outputDir = path.join(root, 'renderer', 'taskbar-badges');
  fs.mkdirSync(outputDir, { recursive: true });
  for (const { name, frames: encoded } of rasterized) {
    const frames = encoded.map(png => Buffer.from(png, 'base64'));
    fs.writeFileSync(path.join(outputDir, `${name}.ico`), encodeBadgeIco(frames));
    // Native overlays select the physical DPI frame directly. The 16px PNG is
    // retained for Electron fallback when the Windows bridge is unavailable.
    sizes.forEach((size, index) => {
      if (size > 128) return;
      const suffix = size === 16 ? '' : `@${size / 16}x`;
      fs.writeFileSync(path.join(outputDir, `${name}${suffix}.png`), frames[index]);
    });
  }
  console.log('Generated taskbar count ICOs (' + sizes.join('/') + 'px): ' + badges.map(({ name }) => `${name}.ico`).join(', '));
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
