'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Marked } = require('../renderer/vendor/marked.umd');
const Images = require('../renderer/local-markdown-images');

test('marked image renderer emits inert escaped placeholders for native, mounted, UNC and relative local paths', () => {
  const marked = new Marked({ renderer: { image: Images.image } });
  for (const href of [String.raw`C:\Users\Fixture\preview.png`, 'C:%5CUsers%5CFixture%5Cpreview.png', '/mnt/c/Fixture/preview.png', './assets/preview.png', String.raw`\\wsl.localhost\Ubuntu\home\fixture\preview.png`]) {
    const html = marked.parse(`![图片](<${href}>)`);
    assert.match(html, /data-relay-local-image=/, href);
    assert.doesNotMatch(html, /<img|\ssrc=/i, href);
  }
  assert.match(Images.image({ href: 'file&quot;.png', text: '"><img src=x onerror=alert(1)>' }), /&lt;img/);
  assert.doesNotMatch(Images.image({ href: 'file.png', text: '<img src=x>' }), /<img/);
});

test('unsupported image schemes stay inert while regular web images preserve their existing pipeline', () => {
  const marked = new Marked({ renderer: { image: Images.image } });
  for (const href of ['javascript:alert(1)', 'C:%255Cpreview.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'file:///C:/bad%00.png']) {
    assert.doesNotMatch(marked.parse(`![预览](<${href}>)`), /<img|\ssrc=|data-relay-local-image=/i);
  }
  assert.match(marked.parse('![网络图片](https://example.invalid/image.png)'), /<img src="https:\/\//);
});

test('only correctly formed bitmap data URLs within the same eight MiB reader limit can mount', () => {
  for (const type of ['png', 'jpeg', 'gif', 'webp']) assert.equal(Images.bitmapDataUrl(`data:image/${type};base64,aGVsbG8=`), true);
  for (const value of ['', null, 'data:text/html;base64,aGVsbG8=', 'data:image/svg+xml;base64,aGVsbG8=', 'file:///C:/image.png', 'data:image/png;base64,abcd!', 'data:image/png;base64,a', 'data:image/png;base64,']) assert.equal(Images.bitmapDataUrl(value), false);
  assert.equal(Images.bitmapDataUrl('data:image/png;base64,' + Buffer.alloc(Images.IMAGE_LIMIT).toString('base64')), true);
  assert.equal(Images.bitmapDataUrl('data:image/png;base64,' + Buffer.alloc(Images.IMAGE_LIMIT + 1).toString('base64')), false);
});
