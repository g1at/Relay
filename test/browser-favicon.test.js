'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserFavicon, faviconUrl, MAX_BYTES } = require('../src/main/browser/browser-favicon');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', 'base64');
const data = 'data:image/png;base64,' + png.toString('base64');

// Valid one-entry ICO directory embedding the existing 1px PNG.
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4);
icoHeader[6] = 1; icoHeader[7] = 1;
icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14); icoHeader.writeUInt32LE(22, 18);
const ico = Buffer.concat([icoHeader, png]);
const icoData = 'data:image/x-icon;base64,' + ico.toString('base64');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="red" d="M0 0h16v16H0z"/></svg>';
const svgData = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const response = (body = png, mime = 'image/png') => new Response(body, { headers: { 'Content-Type': mime } });
const tick = () => new Promise(setImmediate);
function fixture(fetch, extra = {}) {
  const tab = { url: 'https://page.test/doc', documentUrl: 'https://page.test/doc', alive: true }, changes = [], requests = [];
  const partition = { fetch(url, options) { requests.push({ url, options, session: this }); return fetch(url, options); } };
  const loader = createBrowserFavicon({ partition, current: () => tab, changed: () => changes.push(loader.snapshot()), ...extra });
  return { loader, tab, requests, changes, partition };
}
test('favicon input accepts bounded raster and static SVG data while rejecting active or privileged URLs', () => {
  assert.equal(faviconUrl(data), data); assert.equal(faviconUrl(svgData), svgData);
  assert.equal(faviconUrl('data:image/svg+xml,' + encodeURIComponent(svg)), svgData);
  assert.equal(faviconUrl('/favicon.ico', 'http://10.0.0.1/page'), 'http://10.0.0.1/favicon.ico');
  for (const value of ['file:///private.png', 'javascript:alert(1)', 'blob:https://page.test/a', 'https://user:secret@page.test/x',
    'data:text/html;base64,' + Buffer.from('<svg/>').toString('base64'), 'data:image/png;base64,' + Buffer.from('<html>bad</html>').toString('base64')]) {
    assert.equal(faviconUrl(value), null, value);
  }
  for (const body of ['<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"></svg>',
    '<svg><foreignObject/></svg>', '<svg><image href="https://else.test/x"/></svg>',
    '<svg><use href="https://else.test/x#p"/></svg>', '<svg><path fill="url(https://else.test/x)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY a SYSTEM "file:///private">]><svg></svg>', '<svg><style>@import "https://else.test/x"</style></svg>']) {
    assert.equal(faviconUrl('data:image/svg+xml;base64,' + Buffer.from(body).toString('base64')), null, body);
  }
});
test('icons use the owning browser Session, same-origin cookies and safe data output', async () => {
  const f = fixture(() => response()); await f.loader.update(['/icon.png']);
  assert.equal(f.loader.snapshot(), data); assert.deepEqual(f.changes, [data]);
  assert.equal(f.requests[0].session, f.partition); assert.equal(f.requests[0].options.credentials, 'include');
  assert.equal(f.requests[0].options.redirect, 'manual'); assert.equal(f.requests[0].options.referrerPolicy, 'no-referrer');
  await f.loader.update([]); assert.equal(f.loader.snapshot(), null); f.loader.close();
});
test('each redirect is checked and cross-origin icons receive no profile cookies', async () => {
  const f = fixture(url => url.endsWith('/start') ? new Response(null, { status: 302, headers: { location: 'https://cdn.test/icon' } }) : response());
  await f.loader.update(['/start']); assert.equal(f.loader.snapshot(), data);
  assert.deepEqual(f.requests.map(request => request.options.credentials), ['include', 'omit']);
  f.loader.close();
  const blocked = fixture(() => new Response(null, { status: 302, headers: { location: 'file:///private/icon.png' } }));
  await blocked.loader.update(['/start']); assert.equal(blocked.requests.length, 1); assert.equal(blocked.loader.snapshot(), null); blocked.loader.close();
  const loop = fixture(() => new Response(null, { status: 302, headers: { location: '/again' } }));
  await loop.loader.update(['/start']); assert.equal(loop.requests.length, 4); assert.equal(loop.loader.snapshot(), null); loop.loader.close();
});
test('invalid SVG, HTML and network failures fall back to the next safe candidate', async () => {
  const f = fixture(url => url.endsWith('/svg') ? response('<svg><script/></svg>', 'image/svg+xml')
    : url.endsWith('/html') ? response('<html>no icon</html>', 'text/html') : response());
  await f.loader.update(['/svg', '/html', '/valid']); assert.equal(f.loader.snapshot(), data); assert.equal(f.requests.length, 3);
  await f.loader.update([svgData]); assert.equal(f.loader.snapshot(), svgData); assert.equal(f.requests.length, 3); f.loader.close();
});
for (const [name, body, mime, expected] of [
  ['ICO directory with its canonical MIME', ico, 'image/x-icon', icoData],
  ['ICO directory mislabeled as PNG', ico, 'image/png', icoData],
  ['PNG mislabeled as an icon', png, 'image/x-icon', data],
  ['ICO directory with the image/ico alias', ico, 'image/ico', icoData],
]) {
  test('favicon normalizes actual image bytes: ' + name, async () => {
    const f = fixture(() => response(body, mime));
    try {
      await f.loader.update(['/favicon.ico']);
      assert.equal(f.loader.snapshot(), expected);
    } finally { f.loader.close(); }
  });
}
test('HTML bodies remain rejected when mislabeled with accepted icon MIME types', async () => {
  for (const mime of ['image/png', 'image/x-icon', 'image/ico']) {
    const f = fixture(() => response('<!doctype html><html><body>not an icon</body></html>', mime));
    try {
      await f.loader.update(['/favicon.ico']);
      assert.equal(f.loader.snapshot(), null, mime);
    } finally { f.loader.close(); }
  }
});

test('declared and streaming size limits reject oversized images and cancel their bodies', async () => {
  let cancelled = 0;
  const declared = fixture(() => new Response(new ReadableStream({ cancel() { cancelled++; } }),
    { headers: { 'content-type': 'image/png', 'content-length': String(MAX_BYTES + 1) } }));
  await declared.loader.update(['/large']); assert.equal(declared.loader.snapshot(), null); assert.equal(cancelled, 1); declared.loader.close();
  const streamed = fixture(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(png); controller.enqueue(new Uint8Array(MAX_BYTES));
  }, cancel() { cancelled++; } }), { headers: { 'content-type': 'image/png' } }));
  await streamed.loader.update(['/large']); assert.equal(streamed.loader.snapshot(), null); assert.equal(cancelled, 2); streamed.loader.close();
});
test('timeout completes even if an upstream ignores abort, and does not retain an icon', async () => {
  const f = fixture(() => new Promise(() => {}), { timeoutMs: 20 });
  await f.loader.update(['/slow']); assert.equal(f.loader.snapshot(), null); assert.equal(f.requests[0].options.signal.aborted, true); f.loader.close();
});
test('reload, navigation and close cancel reads; late results cannot replace a newer favicon', async () => {
  let finish;
  const f = fixture(url => url.endsWith('/slow') ? new Promise(resolve => { finish = resolve; }) : response(svg, 'image/svg+xml'));
  const old = f.loader.update(['/slow']); await tick();
  f.loader.reset(); assert.equal(f.requests[0].options.signal.aborted, true); await old;
  await f.loader.update(['/new']); assert.equal(f.loader.snapshot(), svgData);
  finish(response()); await tick(); assert.equal(f.loader.snapshot(), svgData);
  const waiting = f.loader.update(['/slow']); await tick(); f.tab.alive = false; f.loader.close(); await waiting;
  finish(response()); await tick(); assert.equal(f.loader.snapshot(), null);
  const before = f.requests.length; await f.loader.update(['/new']); assert.equal(f.requests.length, before);
});
test('document binding discards stale events and same-document fragments keep the active icon', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.tab.documentUrl = 'https://old.test/'; await f.loader.update(['/ignored']); assert.equal(f.requests.length, 0);
  f.tab.documentUrl = f.tab.url; const pending = f.loader.update(['/icon']); await tick();
  f.tab.url += '#section'; f.tab.documentUrl = f.tab.url;
  finish(response()); await pending; assert.equal(f.loader.snapshot(), data);
  const stale = f.loader.update(['/icon']); await tick(); f.tab.url = 'https://next.test/'; f.tab.documentUrl = f.tab.url;
  finish(response()); await stale; assert.equal(f.loader.snapshot(), null); f.loader.close();
});
