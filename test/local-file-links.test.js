'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../renderer/local-file-links');
const marked = require('../renderer/vendor/marked.umd');

test('actual marked Windows hrefs decode drive separators once without reinterpreting encoded filename punctuation', () => {
  for (const href of [String.raw`C:\Users\Fixture\RelayProjects\calculator.html`, String.raw`D:\项目\报告%23终稿.md`, 'C:%2FUsers%2FFixture%2Freport%3Ffinal.md']) {
    const html = marked.parse(`[文件](<${href}>)`);
    const emitted = /href="([^"]+)"/.exec(html)[1];
    assert.deepEqual(parse(emitted), { path: decodeURIComponent(href), line: null });
  }
  assert.deepEqual(parse('C:%5cProject%5creport.md#L12'), { path: String.raw`C:\Project\report.md`, line: 12 });
  for (const href of ['C:%255CUsers%255CFoo.png', 'javascript%3Aalert(1)', 'C:%5Cfile%00.png', 'C:%5Cfile.png?raw=1', 'https:%2F%2Fexample.com/file.png']) {
    assert.equal(parse(href), null, href);
  }
});

test('local markdown destinations preserve Windows, WSL and relative paths with spaces and line numbers', () => {
  for (const [href, file, line] of [
    ['D:/My Project/report.md:42', 'D:/My Project/report.md', 42],
    ['D:\\My Project\\main.js:7:2', 'D:\\My Project\\main.js', 7],
    ['/mnt/d/My%20Project/report.md:12', '/mnt/d/My Project/report.md', 12],
    ['docs/README.md#L34', 'docs/README.md', 34],
    ['child.txt:3', 'child.txt', 3],
    ['main.js:12:2', 'main.js', 12],
    ['../README.md', '../README.md', null],
    ['file:///D:/My%20Project/report.md:3', 'D:/My Project/report.md', 3],
    ['README.md#section', 'README.md', null],
    ['报告%20final.pdf', '报告 final.pdf', null],
  ]) assert.deepEqual(parse(href), { path: file, line }, href);
});

test('web, anchor-only, executable protocols and control characters are never local file destinations', () => {
  for (const href of ['https://example.com/file.md', 'http://example.com', 'mailto:user@example.com', '//example.com/file',
    '#part', '?download=true', 'javascript:alert(1)', 'javascript%3Aalert(1)', 'data:text/html,x', 'vscode://file/a',
    'C:relative.txt', 'bad\0file.md', 'file:///D:/x%00.md', 'a.md:0', 'a.md:10000001']) assert.equal(parse(href), null, href);
});
