'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const browser = require('../renderer/browser-activity');
global.window = {};
const activity = require('../renderer/activity-stream');
const tool = verb => 'mcp__relay-browser__' + verb;
function received(verb, data, error = false) {
  const state = activity.createState();
  activity.ingest(state, { type: 'assistant', uuid: 'call-frame', message: { content: [{ type: 'tool_use', id: 'call', name: tool(verb), input: { tabId: 'page-1' } }] } });
  activity.ingest(state, { type: 'user', uuid: 'result-frame', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: error, content: JSON.stringify(data) }] } });
  return state;
}
test('only Relay browser tools receive friendly titles and locator detail is bounded', () => {
  assert.equal(browser.friendly('mcp__other__verify'), null);
  assert.equal(browser.friendly(tool('act'), { kind: 'fill', locator: { name: 'Email' } }).title, '填写网页');
  assert.equal(browser.friendly(tool('observe'), { url: 'x'.repeat(1000) }).detail.length, 300);
});
test('MCP envelopes unwrap business verification separately from transport success', () => {
  for (const data of [{ ok: true, verified: false }, { response: JSON.stringify({ ok: true, verified: false }) },
    { content: [{ type: 'text', text: JSON.stringify({ ok: true, verified: false }) }] }]) {
    const result = browser.summarize(tool('verify'), JSON.stringify(data));
    assert.equal(result.tone, 'error'); assert.match(result.label, /未通过/);
  }
  assert.equal(browser.summarize(tool('verify'), { ok: true, verified: true }).tone, 'success');
  assert.equal(browser.summarize(tool('wait'), { ok: true, satisfied: false }).tone, 'error');
  assert.equal(browser.summarize(tool('wait'), { ok: true, satisfied: true }).tone, 'success');
});
test('unknown outcomes request observation instead of encouraging a duplicate action', () => {
  const result = browser.summarize(tool('act'), { ok: false, outcome: 'unknown', error: 'timeout' });
  assert.equal(result.tone, 'warning'); assert.match(result.detail, /勿直接重复/);
  const state = received('act', { ok: false, outcome: 'unknown' });
  assert.equal(state.items[0].status, 'unconfirmed');
});
test('only local evidence paths become resources and actions do not claim business completion', () => {
  const shot = browser.summarize(tool('screenshot'), { ok: true, artifact: { path: 'C:\\tasks\\shot.png' } });
  assert.equal(shot.resources.length, 1); assert.equal(shot.imagePath, 'C:\\tasks\\shot.png');
  assert.equal(browser.summarize(tool('download'), { ok: true, download: { path: '/tasks/file.zip' } }).resources.length, 1);
  for (const path of ['https://site.test/shot.png', '../shot.png', 'data:image/png;base64,x', '/tasks/a\n.png']) {
    const result = browser.summarize(tool('screenshot'), { ok: true, artifact: { path } });
    assert.equal(result.resources.length, 0); assert.equal(result.imagePath, null);
  }
  const executed = browser.summarize(tool('act'), { ok: true, executed: true });
  assert.equal(executed.label, '已执行'); assert.equal(executed.detail, ''); assert.equal(executed.tone, 'neutral');
});
test('verify false remains an error in live activity, saved history and legacy hydration', () => {
  const state = received('verify', { ok: true, verified: false });
  assert.equal(state.items[0].status, 'error'); assert.match(activity.renderItem(state.items[0], false), /页面结果未通过核验/);
  activity.finish(state, { type: 'result', subtype: 'success' });
  assert.equal(state.items[0].status, 'error');
  const restored = activity.hydrate(activity.serialize(state)); assert.equal(restored.items[0].status, 'error');
  const legacy = activity.hydrate({ phase: 'complete', items: [{ id: 'old', type: 'tool', toolName: tool('verify'), status: 'success', result: '{"ok":true,"verified":false}' }] });
  assert.equal(legacy.items[0].status, 'error');
});
test('retracted tool result removes its old verdict and evidence', () => {
  const state = received('screenshot', { ok: true, artifact: { path: '/tasks/shot.png' } });
  assert.equal(state.items[0].resources.length, 1);
  activity.ingest(state, { type: 'system', subtype: 'model_refusal_fallback', retracted_message_uuids: ['result-frame'] });
  assert.equal(state.items[0].status, 'superseded'); assert.equal(state.items[0].browser, undefined); assert.equal(state.items[0].resources.length, 0);
});
test('screenshot stays lazy until clicked and failed previews never display another image', async () => {
  const state = received('screenshot', { ok: true, artifact: { path: '/tasks/shot.png' } }), item = state.items[0];
  const html = activity.renderItem(item, false); assert.match(html, /预览截图/); assert.doesNotMatch(html, /src=/);
  const image = { hidden: true }, row = { _processItem: item }, button = { isConnected: true, parentElement: { querySelector: () => image }, closest: () => row, setAttribute(name, value) { this[name] = value; } };
  const paths = []; global.window.api = { image: { toDataUrl: async path => { paths.push(path); return { ok: true, dataUrl: 'data:image/png;base64,aGVsbG8=' }; } } };
  await activity.previewBrowserEvidence(button, item);
  assert.deepEqual(paths, ['/tasks/shot.png']); assert.equal(image.hidden, false); assert.equal(button['aria-expanded'], 'true');
  await activity.previewBrowserEvidence(button, item); assert.equal(image.hidden, true); assert.equal(paths.length, 1);
  global.window.api.image.toDataUrl = async () => ({ ok: true, dataUrl: 'https://outside.test/image.png' });
  await activity.previewBrowserEvidence(button, item); assert.equal(image.hidden, true); assert.match(button.textContent, /失败/);
});

test('a replacement transport error removes a stale saved-screenshot verdict', () => {
  const state = received('screenshot', { ok: true, artifact: { path: '/tasks/shot.png' } });
  activity.ingest(state, { type: 'user', uuid: 'new-result', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: true, content: 'Browser closed' }] } });
  assert.equal(state.items[0].status, 'error'); assert.equal(state.items[0].browser, undefined); assert.equal(state.items[0].resources.length, 0);
  assert.doesNotMatch(activity.renderItem(state.items[0], true), /截图已保存/);
});

test('saved evidence keeps its real file link when indexing fails and exposes the warning', () => {
  const result = browser.summarize(tool('screenshot'), { ok: true, artifact: { path: '/task/shot.png', evidenceWarning: '证据索引写入失败，请保留路径' } });
  assert.equal(result.resources[0].uri, '/task/shot.png'); assert.match(result.label, /已保存/); assert.match(result.detail, /索引写入失败/); assert.equal(result.tone, 'neutral');
});

test('an executed action with an unmet event stays unconfirmed through live and saved activity', () => {
  const result = { ok: true, executed: true, waitResult: { satisfied: false, timedOut: true } };
  const summary = browser.summarize(tool('act'), result);
  assert.equal(summary.tone, 'warning'); assert.match(summary.label, /动作已执行/); assert.match(summary.detail, /勿直接重复/);
  const state = received('act', result); assert.equal(state.items[0].status, 'unconfirmed');
  activity.finish(state, { type: 'result', subtype: 'success' });
  assert.equal(activity.hydrate(activity.serialize(state)).items[0].status, 'unconfirmed');
  const waited = browser.summarize(tool('act'), { ok: true, executed: true, waitResult: { satisfied: true } });
  assert.equal(waited.detail, ''); assert.equal(waited.tone, 'neutral'); assert.match(waited.label, /等待条件已满足/);
});


test('browser receipt is part of the ordinary tool title and details remain in the inspector', () => {
  const complete = received('act', { ok: true, executed: true });
  const compact = activity.renderItem(complete.items[0], false);
  assert.match(compact, /process-item-title[^]*<span class="process-browser-result is-neutral"[^>]*>已执行<\/span><\/div>/);
  assert.doesNotMatch(compact, /<div class="process-browser-result|动作完成不等于|仍需核验|<strong>/);
  assert.match(compact, /aria-expanded="false"/);
  const unknown = received('act', { ok: false, outcome: 'unknown' });
  const html = activity.renderItem(unknown.items[0], false);
  const main = html.slice(html.indexOf('<div class="process-item-main">'), html.indexOf('<div class="process-inspector">'));
  assert.match(main, /process-browser-result is-warning/);
  assert.match(main, /操作结果未确认/);
  assert.doesNotMatch(main, /勿直接重复|process-item-detail/);
  assert.match(html, /process-inspect-section is-browser[^]*勿直接重复/);
});

test('browser states retain their distinct labels through compact rendering and history', () => {
  for (const [verb, result, status, label] of [
    ['verify', { ok: true, verified: false }, 'error', '页面结果未通过核验'],
    ['verify', { ok: true, verified: true }, 'success', '页面结果已核验'],
    ['wait', { ok: true, satisfied: false }, 'error', '等待结束，条件尚未满足'],
    ['wait', { ok: true, satisfied: true }, 'success', '页面已达到等待条件'],
    ['act', { ok: false, error: '<script>unsafe</script>' }, 'error', '网页操作未完成'],
    ['act', { ok: false, outcome: 'unknown' }, 'unconfirmed', '操作结果未确认'],
  ]) {
    const state = received(verb, result);
    const restored = activity.hydrate(activity.serialize(state));
    assert.equal(restored.items[0].status, status);
    const html = activity.renderItem(restored.items[0], false);
    assert.match(html, new RegExp('process-browser-result[^>]*>[^<]*' + label));
    assert.doesNotMatch(html, /<script>/);
  }
});
