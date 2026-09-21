'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const localWindow = {};
new Function('window', fs.readFileSync(path.join(__dirname, '../renderer/activity-stream.js'), 'utf8'))(localWindow);
const render = input => localWindow.RelayActivity.renderItem({ id: 'tool', type: 'tool', toolName: 'mcp__fixture__update', title: '调用服务', status: 'success', ...input }, true);

test('structured input keeps argument names and readable multiline strings without altering stored values', () => {
  const input = { document_id: 'fixture', markdown: '# Heading\n\n- first\n- second', literal_path: 'C:\\new\\test', enabled: false, offset: 0, missing: null, empty: '', nested: { names: ['one', 'two'] } };
  const before = JSON.stringify(input), html = render({ input });
  assert.match(html, /process-inspect-fields/);
  for (const name of Object.keys(input)) assert.ok(html.includes(`<dt>${name}</dt>`));
  assert.ok(html.includes('# Heading\n\n- first\n- second'));
  assert.ok(html.includes('C:\\new\\test'));
  assert.ok(html.includes('<pre>false</pre>'));
  assert.ok(html.includes('<pre>0</pre>'));
  assert.ok(html.includes('<pre>null</pre>'));
  assert.ok(html.includes('<pre>&quot;&quot;</pre>'));
  assert.equal(JSON.stringify(input), before);
});

test('input and JSON output keep recursive credential redaction and escape hostile markup', () => {
  const html = render({ toolName: '<img src=x onerror=alert(1)>', input: { api_key: 'input-secret', nested: { password: 'nested-secret' }, '<script>': '<img onerror=alert(2)>' }, result: JSON.stringify({ token: 'result-secret', nested: { Authorization: 'Bearer secret' }, data: '</pre><script>alert(3)</script>' }) });
  for (const secret of ['input-secret', 'nested-secret', 'result-secret', 'Bearer secret']) assert.ok(!html.includes(secret));
  assert.match(html, /••••••••/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /process-json-key/);
});

test('bounded long input stays on safe plain-text fallback and restored previews remain readable', () => {
  const html = render({ input: { content: 'x'.repeat(9000), token: 'must-not-leak' } });
  assert.match(html, /内容过长，已截断/);
  assert.doesNotMatch(html, /must-not-leak|process-inspect-fields/);
  assert.ok(html.length < 8500);
  const restored = render({ input: { preview: 'first\nsecond', truncated: true } });
  assert.match(restored, /first\nsecond/);
  assert.match(restored, /<dt>truncated<\/dt>/);
});

test('command display and empty, error, or Markdown results retain existing semantics', () => {
  const command = render({ toolName: 'Bash', input: { command: 'printf "%s\\n" "<literal>"' }, result: 'done' });
  assert.match(command, /printf &quot;%s\\n&quot; &quot;&lt;literal&gt;&quot;/);
  assert.doesNotMatch(command, /process-inspect-fields/);
  const error = render({ input: { path: '/fixture' }, status: 'error', error: '<bad> denied' });
  assert.match(error, /is-error/); assert.match(error, /&lt;bad&gt; denied/);
  const markdown = render({ toolName: 'Read', input: { file_path: 'readme.md' }, result: '# Safe\n\n- item' });
  assert.match(markdown, /process-inspect-markdown/);
  assert.match(markdown, /Markdown/);
  const empty = render({ input: {}, result: '' });
  assert.doesNotMatch(empty, /process-inspect-panel/);
});


test('conversation errors retain complete plain diagnostics and replace only the legacy emoji prefix', () => {
  const renderError = localWindow.RelayActivity.renderError;
  const text = '工具权限被拒绝（1 次）：mcp__fixture__update';
  const html = renderError('❌ ' + text);
  assert.match(html, /role="alert"/);
  assert.match(html, /conversation-error-icon/);
  assert.ok(html.includes(text));
  assert.ok(!html.includes('❌'));
  assert.ok(renderError('🖼️ 图片生成失败').includes('图片生成失败'));
  assert.ok(renderError('⚠️ 请求失败').includes('请求失败'));
  assert.ok(renderError('请求已返回 ❌ 原始信息').includes('请求已返回 ❌ 原始信息'));
  assert.ok(renderError(null).includes('执行未完成'));
  const diagnostic = '[stderr] <img src=x onerror=alert(1)>\n' + 'long diagnostic line\n'.repeat(80);
  const long = renderError(diagnostic);
  assert.ok(long.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.doesNotMatch(long, /<img/);
  assert.equal((long.match(/long diagnostic line/g) || []).length, 80);
});
