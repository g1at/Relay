'use strict';

// Exact small/large shell sizes at 100%, 125%, 150%, 175%, 200%, 250%
// and 300%, plus Explorer's larger representations. Avoid scaling a 16px
// HICON at fractional DPI when an independently sampled frame is available.
const ICON_SIZES = Object.freeze([16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 128, 256]);
const NATIVE_SAMPLE_FACTOR = 8;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function createDefaultLogoAssets(master) {
  if (typeof master !== 'string' || !master.includes('viewBox="0 0 1024 1024"')
    || !master.includes('#17191D') || !master.includes('#1F6FEB')) {
    throw new Error('The approved Relay logo master has an unexpected viewBox or palette');
  }
  // Keep the approved geometry, including the relative size of its blue core.
  // Keep the existing renderer exports stable. Native shell artwork has a
  // separate viewport below, so optical adjustments do not resize UI branding.
  const optical = svg => svg.replace('viewBox="0 0 1024 1024"', 'viewBox="48 48 928 928"');
  const dark = master.replaceAll('#17191D', '#F4F7FA').replaceAll('#1F6FEB', '#3B82F6');
  return { 'logo.svg': master, 'logo-dark.svg': dark,
    'logo-app.svg': optical(master), 'logo-app-dark.svg': optical(dark) };
}

function createNativeIconAssets(master) {
  const assets = createDefaultLogoAssets(master);
  // Native shell only: 800 / 736 = 1.087, another 8.7% optical enlargement.
  // Exact Bezier bounds are x=160..864, y=154.450..869.550, so this centered
  // viewport retains every path with >=10.45 source units of clear margin.
  // The gate occupies 95.7% of the frame width; UI artwork remains unchanged.
  const native = svg => svg.replace('viewBox="0 0 1024 1024"', 'viewBox="144 144 736 736"');
  return { 'icon.svg': native(assets['logo.svg']), 'icon-dark.svg': native(assets['logo-dark.svg']) };
}

function encodeIco(frames) {
  if (!Array.isArray(frames) || frames.length !== ICON_SIZES.length) throw new Error(`An ICO needs all ${ICON_SIZES.length} DPI frames`);
  const header = Buffer.alloc(6 + ICON_SIZES.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(ICON_SIZES.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const size = ICON_SIZES[index];
    if (!Buffer.isBuffer(frame) || frame.length < 24 || !frame.subarray(0, 8).equals(PNG_SIGNATURE)
      || frame.readUInt32BE(16) !== size || frame.readUInt32BE(20) !== size) {
      throw new Error(`Invalid ${size}px PNG frame`);
    }
    const start = 6 + index * 16;
    header[start] = header[start + 1] = size % 256;
    header.writeUInt16LE(1, start + 4);
    header.writeUInt16LE(32, start + 6);
    header.writeUInt32LE(frame.length, start + 8);
    header.writeUInt32LE(offset, start + 12);
    offset += frame.length;
  });
  return Buffer.concat([header, ...frames]);
}

// Average pixel coverage explicitly instead of relying on Canvas's unspecified
// imageSmoothingQuality downscale filter. Canvas getImageData returns straight
// alpha, so colors must be accumulated premultiplied and unpremultiplied only
// once. This retains smooth coverage without dark fringes on a light taskbar.
// Kept self-contained so the Electron build renderer uses this exact function.
function downsampleRgba(source, size, factor) {
  if (!Number.isInteger(size) || size < 1 || !Number.isInteger(factor) || factor < 1
    || !source || source.length !== size * size * factor * factor * 4) {
    throw new Error('Invalid supersampled RGBA dimensions');
  }
  const width = size * factor, samples = factor * factor, target = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let alpha = 0, red = 0, green = 0, blue = 0;
    for (let sy = 0; sy < factor; sy++) for (let sx = 0; sx < factor; sx++) {
      const index = ((y * factor + sy) * width + x * factor + sx) * 4, a = source[index + 3];
      alpha += a; red += source[index] * a; green += source[index + 1] * a; blue += source[index + 2] * a;
    }
    const index = (y * size + x) * 4, coverage = Math.round(alpha / samples);
    if (coverage) {
      target[index] = Math.round(red / alpha); target[index + 1] = Math.round(green / alpha); target[index + 2] = Math.round(blue / alpha); target[index + 3] = coverage;
    }
  }
  return target;
}

module.exports = { ICON_SIZES, NATIVE_SAMPLE_FACTOR, createDefaultLogoAssets, createNativeIconAssets, encodeIco, downsampleRgba };
