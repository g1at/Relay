'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ICON_SIZES, createDefaultLogoAssets, encodeIco, downsampleRgba } = require('../build/logo-assets.cjs');
const root = path.resolve(__dirname, '..');
const masterFile = path.join(root, 'design/relay-logo/relay-dual-gate-master.svg');
const runtimeLogo = fs.readFileSync(path.join(root, 'renderer/logo.svg'), 'utf8');

test('runtime SVG variants preserve the gate and core without adding a background tile', () => {
  const assets = createDefaultLogoAssets(runtimeLogo);
  for (const [name, svg] of Object.entries(assets)) {
    const normalized = svg.replace('viewBox="48 48 928 928"', 'viewBox="0 0 1024 1024"')
      .replaceAll('#F4F7FA', '#17191D').replaceAll('#3B82F6', '#1F6FEB');
    assert.equal(normalized, runtimeLogo, `${name}: only its viewport and theme colors may differ`);
    assert.equal((svg.match(/<rect\b/g) || []).length, 1, 'the blue core is the sole rectangle');
    assert.equal(fs.readFileSync(path.join(root, 'renderer', name), 'utf8'), svg, 'runtime SVG matches its generated source');
  }
  assert.equal(assets['logo.svg'], runtimeLogo, 'regular UI keeps its original artwork');
  assert.match(assets['logo-app.svg'], /viewBox="48 48 928 928"/);
  assert.match(assets['logo-app-dark.svg'], /fill="#F4F7FA"/);
  assert.match(assets['logo-app-dark.svg'], /fill="#3B82F6"/);
});

test('runtime SVG artwork exactly matches the local approved design master', {
  skip: fs.existsSync(masterFile) ? false : 'Local design/ master is not included in the source checkout.',
}, () => {
  const master = fs.readFileSync(masterFile, 'utf8');
  assert.equal(runtimeLogo, master);
  for (const [name, svg] of Object.entries(createDefaultLogoAssets(master))) {
    assert.equal(fs.readFileSync(path.join(root, 'renderer', name), 'utf8'), svg);
  }
});

test('an incompatible master cannot silently generate unrelated application artwork', () => {
  assert.throws(() => createDefaultLogoAssets('<svg/>'), /unexpected viewBox or palette/);
  assert.throws(() => createDefaultLogoAssets(runtimeLogo.replace('#17191D', '#ff0000')), /unexpected viewBox or palette/);
});

// Only the ICO container is under test here. Pixel/alpha validation belongs to
// the real Electron rasterization check, so these tiny IHDR payloads carry no
// invented pixel data or dependency on a native graphics implementation.
function fixturePng(size, id) {
  const buffer = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12);
  buffer.writeUInt32BE(size, 16); buffer.writeUInt32BE(size, 20); buffer[24] = id;
  return buffer;
}

test('ICO output preserves independently sampled fractional-DPI frames with valid nonoverlapping entries', () => {
  assert.deepEqual(ICON_SIZES, [16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 128, 256]);
  const frames = ICON_SIZES.map(fixturePng), ico = encodeIco(frames);
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), ICON_SIZES.length);
  let end = 6 + ICON_SIZES.length * 16;
  ICON_SIZES.forEach((size, index) => {
    const entry = 6 + index * 16, length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.equal(ico[entry] || 256, size); assert.equal(ico[entry + 1] || 256, size);
    assert.equal(ico.readUInt16LE(entry + 4), 1); assert.equal(ico.readUInt16LE(entry + 6), 32);
    assert.equal(offset, end); assert.equal(length, frames[index].length);
    assert.deepEqual(ico.subarray(offset, offset + length), frames[index]); end += length;
  });
  assert.equal(end, ico.length);
});

test('missing, invalid or mismatched raster frames cannot produce a misleading ICO directory', () => {
  const frames = ICON_SIZES.map(fixturePng);
  assert.throws(() => encodeIco(frames.slice(1)), /13 DPI frames/);
  assert.throws(() => encodeIco([Buffer.alloc(25), ...frames.slice(1)]), /Invalid 16px/);
  assert.throws(() => encodeIco([fixturePng(32, 0), ...frames.slice(1)]), /Invalid 16px/);
});

test('area downsampling preserves partial edge coverage without transparent color fringes', () => {
  // A quarter-covered blue edge with arbitrary RGB in transparent pixels.
  const rgba = new Uint8ClampedArray([31, 111, 235, 255, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...downsampleRgba(rgba, 1, 2)], [31, 111, 235, 64]);
  assert.deepEqual([...downsampleRgba(new Uint8ClampedArray(16).fill(255), 1, 2)], [255, 255, 255, 255]);
  assert.deepEqual([...downsampleRgba(new Uint8ClampedArray(16), 1, 2)], [0, 0, 0, 0]);
});

test('supersampling keeps target pixels independent and rejects inconsistent input dimensions', () => {
  const source = new Uint8ClampedArray(4 * 4 * 4);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) source.set([23, 25, 29, 255], (y * 4 + x) * 4);
  assert.deepEqual([...downsampleRgba(source, 2, 2)], [23, 25, 29, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => downsampleRgba(source, 3, 2), /dimensions/);
  assert.throws(() => downsampleRgba(source, 2, 1.5), /dimensions/);
});
