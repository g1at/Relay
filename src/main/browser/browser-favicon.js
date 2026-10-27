'use strict';

const MAX_BYTES = 256 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml']);
const stopBody = response => { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch (_) {} };
function safeSvg(bytes) {
  const source = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/^\s*<\?xml\s[^?]*\?>/i, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!/^<svg(?:\s|>)[\s\S]*<\/svg>$/i.test(source) && !/^<svg\s[^>]*\/>$/i.test(source)) return false;
  if (/<[!?]|&#|\bon[a-z]+\s*=|\b(?:style|xml:base)\s*=/i.test(source)) return false;
  const tags = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc', 'use', 'symbol', 'pattern', 'text', 'tspan']);
  for (const match of source.matchAll(/<\/?([^\s/>]+)([^>]*)>/g)) {
    if (!tags.has(match[1])) return false;
    const attributes = match[2].replace(/\/\s*$/, '');
    const pairs = [...attributes.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)];
    if (attributes.replace(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs, '').trim()) return false;
    for (const [, name, , value] of pairs) {
      if (/^(?:href|xlink:href)$/i.test(name) && !/^#[\w.-]+$/.test(value)) return false;
      if (/url\s*\(/i.test(value) && !/^url\(\s*#[\w.-]+\s*\)$/.test(value)) return false;
    }
  }
  return true;
}
function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    if (bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096) return null;
    return 'image/png';
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
    return bytes.readUInt16LE(6) <= 4096 && bytes.readUInt16LE(8) <= 4096 ? 'image/gif' : null;
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x00010000 && bytes.readUInt16LE(4) > 0) return 'image/x-icon';
  return null;
}
function imageData(bytes, mime) {
  if (!bytes.length || bytes.length > MAX_BYTES) return null;
  // Favicon endpoints often label PNG bytes as ICO (including Google).
  // Normalize bounded raster bytes by their signature, not the URL or MIME hint.
  const actual = imageType(bytes);
  if (actual) return 'data:' + actual + ';base64,' + bytes.toString('base64');
  if (mime === 'image/svg+xml') return safeSvg(bytes) ? 'data:image/svg+xml;base64,' + bytes.toString('base64') : null;
  return null;
}
function faviconUrl(value, base) {
  if (typeof value !== 'string' || value.length > MAX_BYTES * 3 + 100 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (value.startsWith('data:')) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/.exec(value);
    if (!match || !TYPES.has(match[1].toLowerCase())) return null;
    if (match[2]) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(match[3]) || match[3].length % 4 !== 0) return null;
      return imageData(Buffer.from(match[3], 'base64'), match[1].toLowerCase());
    }
    try { return imageData(Buffer.from(decodeURIComponent(match[3])), match[1].toLowerCase()); } catch (_) { return null; }
  }
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 16384) return null;
    url.hash = ''; return url.href;
  } catch (_) { return null; }
}
async function fetchFavicon(partition, candidate, pageUrl, signal) {
  let target = candidate;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (target.startsWith('data:')) return target;
    const response = await partition.fetch(target, { method: 'GET', redirect: 'manual', signal,
      credentials: new URL(target).origin === new URL(pageUrl).origin ? 'include' : 'omit', referrerPolicy: 'no-referrer' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); stopBody(response);
      if (!location || redirects === 3 || !(target = faviconUrl(location, target))) return null;
      continue;
    }
    if (!response.ok) { stopBody(response); return null; }
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_BYTES || !response.body?.getReader) { stopBody(response); return null; }
    const reader = response.body.getReader(), chunks = [];
    const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {} };
    signal.addEventListener('abort', cancel, { once: true });
    let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) { cancel(); return null; }
        chunks.push(Buffer.from(next.value));
      }
    } finally { signal.removeEventListener('abort', cancel); try { reader.releaseLock(); } catch (_) {} }
    return imageData(Buffer.concat(chunks, size), mime);
  }
  return null;
}

// One in-flight read per tab, through its own browser Session. Only bounded
// image data reaches Relay's renderer; it never fetches page-supplied URLs.
function createBrowserFavicon({ partition, current, changed = () => {}, timeoutMs = 5000 } = {}) {
  let controller = null, value = null, version = 0, closed = false;
  const pageKey = input => { try { const url = new URL(input); url.hash = ''; return url.href; } catch (_) { return ''; } };
  const publish = next => { if (next !== value) { value = next; if (!closed) changed(); } };
  function reset() { version++; controller?.abort(); controller = null; publish(null); }
  async function update(candidates) {
    reset();
    if (closed || !Array.isArray(candidates)) return;
    const tab = current(), page = pageKey(tab.url);
    if (!tab.alive || !page || page !== pageKey(tab.documentUrl)) return;
    const active = controller = new AbortController(), generation = version;
    let abort;
    const aborted = new Promise((_, reject) => { abort = () => reject(Error('FAVICON_ABORTED')); active.signal.addEventListener('abort', abort, { once: true }); });
    const timer = setTimeout(() => active.abort(), timeoutMs);
    const work = (async () => {
      for (const candidate of candidates.slice(0, 4)) {
        const url = faviconUrl(candidate, page); if (!url) continue;
        try { const image = await fetchFavicon(partition, url, page, active.signal); if (image) return image; }
        catch (_) { if (active.signal.aborted) return null; }
      }
      return null;
    })();
    try {
      const result = await Promise.race([work, aborted]), live = current();
      if (!closed && version === generation && live.alive && pageKey(live.url) === page && pageKey(live.documentUrl) === page) publish(result);
    } catch (_) {} finally {
      clearTimeout(timer); active.signal.removeEventListener('abort', abort);
      if (controller === active) controller = null;
    }
  }
  return { update, reset, snapshot: () => value, close() { closed = true; reset(); } };
}

module.exports = { createBrowserFavicon, faviconUrl, MAX_BYTES };
