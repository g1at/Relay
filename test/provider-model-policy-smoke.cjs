'use strict';
// Isolated diagnostic: dummy auth, loopback API, private temporary user config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const relay = require('../claude-sdk');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-user-model-edges-'));
const records = [], queries = new Set(), checks = [];
const onlyCase = process.argv[2];
const outputDir = path.join(__dirname, '../.codex-tmp/provider-fix-validation');
function check(name, passed) { assert.ok(passed, name); checks.push(name); }
let active;
function sse(res, message) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  function emit(event, payload) { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture-ok' } });
  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  emit('message_stop', { type: 'message_stop' }); res.end();
}
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c);
  req.on('end', () => {
    let body; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    active.requests.push({ model: body.model });
    if (active.forceFailure && body.model === 'relay-main-model') {
      res.writeHead(404, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: relay-main-model not found' } })); return;
    }
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'fixture-ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 5 } };
    if (body.stream) sse(res, message);
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); }
  });
});
async function run(sdk, name, userSettings, flags, { forceFailure = false, hotReload = null, model = 'relay-main-model' } = {}) {
  if (onlyCase && name !== onlyCase) return;
  active = { name, requests: [], result: [], forceFailure, flags: flags || null }; records.push(active);
  const config = path.join(root, name), cwd = path.join(config, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
  const settingsFile = path.join(config, 'settings.json'); fs.writeFileSync(settingsFile, JSON.stringify(userSettings));
  let wake, ended = false, pending, pumpError; const queue = [];
  async function* input() { while (!ended) { if (queue.length) yield queue.shift(); else await new Promise(resolve => wake = resolve); } }
  const abortController = new AbortController();
  const options = relay._buildOptions({ cwd, model, tools: [], abortController, runtimeEnv: {
    CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'fixture-only-no-real-key', ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/anthropic`, ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'relay-fast-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'relay-medium-model',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'relay-main-model', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost',
  } }, sdk);
  options.maxTurns = 1;
  options.stderr = value => { if (/model|settings|error/i.test(value)) (active.stderr ||= []).push(value.slice(0, 1400)); };
  // Baselines intentionally remove the fix to prove the hostile configuration matters.
  if (flags === false) delete options.settings;
  const { env: privateEnv, ...nonsecretOptions } = options;
  check(`${name}: API credential absent from SDK arguments`, !JSON.stringify(nonsecretOptions).includes('fixture-only-no-real-key'));
  if (flags !== false) check(`${name}: user resources remain enabled`, options.settingSources.includes('user'));
  active.flags = options.settings || null;
  const q = sdk.query({ prompt: input(), options }); queries.add(q);
  const pump = (async () => { try { for await (const event of q) {
    if (event.type === 'system' && ['init', 'model_fallback'].includes(event.subtype)) (active.events ||= []).push(event.subtype === 'init' ? { type: 'init', model: event.model } : event);
    if (event.type === 'result') { active.result.push({ result: event.result, is_error: event.is_error, errors: event.errors, subtype: event.subtype }); pending?.resolve(event); pending = null; }
  } } catch (e) { pumpError = e; pending?.reject(e); pending = null; } })();
  async function turn(label) {
    let timer;
    try {
      const terminal = new Promise((resolve, reject) => { pending = { resolve, reject }; });
      queue.push({ type: 'user', message: { role: 'user', content: label }, parent_tool_use_id: null, session_id: '', uuid: randomUUID() });
      if (wake) { wake(); wake = null; }
      if (pumpError) throw pumpError;
      await Promise.race([terminal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('turn timeout')), 30000); })]);
    } finally { clearTimeout(timer); }
  }
  try {
    await turn('Reply fixture-ok.');
    if (hotReload) {
      fs.writeFileSync(settingsFile, JSON.stringify(hotReload));
      fs.mkdirSync(path.join(config, 'skills/edge-reload'), { recursive: true });
      fs.writeFileSync(path.join(config, 'skills/edge-reload/SKILL.md'), '---\nname: edge-reload\ndescription: Fixture reload\n---\nReply fixture-ok.\n');
      await new Promise(resolve => setTimeout(resolve, 1600)); await q.reloadSkills();
      active.reloadedSkill = (await q.supportedCommands()).some(command => command.name === 'edge-reload');
      active.hotReloadRequestStart = active.requests.length;
      await turn('Reply fixture-ok again after settings reload.');
    }
  } catch (error) { active.error = error.message; }
  finally { ended = true; if (wake) wake(); abortController.abort(); q.close(); await pump; queries.delete(q); }
  console.log(JSON.stringify({ name, requests: active.requests, results: active.result.map(r => ({ error: r.is_error, subtype: r.subtype })), error: active.error, reload: active.reloadedSkill }));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sdk = await relay.loadSdk();
  const overrides = { modelOverrides: { 'relay-main-model': 'foreign-explicit-model', 'claude-opus-4-6': 'foreign-opus', 'claude-sonnet-4-6': 'foreign-sonnet' } };
  const hostile = { ...overrides, availableModels: ['foreign-only'], enforceAvailableModels: true, fallbackModel: ['foreign-fallback'] };
  try {
    await run(sdk, 'overrides-only', overrides, false);
    await run(sdk, 'allowlist-only', { availableModels: ['foreign-only'], enforceAvailableModels: true }, false);
    await run(sdk, 'guarded-hostile', hostile, undefined, { hotReload: { ...hostile, availableModels: ['foreign-reloaded'], modelOverrides: { ...hostile.modelOverrides, 'relay-main-model': 'foreign-reloaded' } } });
    await run(sdk, 'fallback-unprotected', { fallbackModel: ['foreign-fallback'] }, false, { forceFailure: true });
    await run(sdk, 'fallback-protected', { fallbackModel: ['foreign-fallback'] }, undefined, { forceFailure: true });
    await run(sdk, 'explicit-anthropic-id', { modelOverrides: { 'claude-opus-4-6': 'foreign-opus' } }, false, { model: 'claude-opus-4-6' });
    await run(sdk, 'guarded-anthropic-id', { ...hostile, modelOverrides: { 'claude-opus-4-6': 'foreign-opus' } },
      undefined,
      { model: 'claude-opus-4-6', hotReload: { ...hostile, availableModels: ['foreign-hot-reload'], modelOverrides: { 'claude-opus-4-6': 'foreign-opus-reloaded' } } });
    await run(sdk, 'guarded-anthropic-context', { ...hostile, modelOverrides: { 'claude-opus-4-6': 'foreign-opus' } }, undefined,
      { model: 'claude-opus-4-6[1m]', hotReload: { ...hostile, modelOverrides: { 'claude-opus-4-6': 'foreign-opus-reloaded' } } });
    await run(sdk, 'guarded-namespace', { ...hostile, modelOverrides: { 'claude-opus-4-6': 'foreign-opus', 'vendor/claude-opus-4-6': 'foreign-vendor' } }, undefined,
      { model: 'vendor/claude-opus-4-6', hotReload: { ...hostile, modelOverrides: { 'vendor/claude-opus-4-6': 'foreign-vendor-reloaded' } } });
    for (const record of records) {
      check(`${record.name}: query completed`, !record.error && record.result.length > 0);
      const models = record.requests.map(request => request.model);
      if (record.name === 'allowlist-only') check('baseline: inherited allowlist can displace an explicit model', models.some(model => model !== 'relay-main-model'));
      else if (record.name === 'fallback-unprotected') check('baseline: inherited fallback runs an unconfigured model', models.includes('foreign-fallback'));
      else if (record.name === 'explicit-anthropic-id') check('baseline: inherited mapping remaps an explicit canonical model', models.includes('foreign-opus'));
      else {
        const expected = record.name === 'guarded-anthropic-id' || record.name === 'guarded-anthropic-context' ? 'claude-opus-4-6'
          : record.name === 'guarded-namespace' ? 'vendor/claude-opus-4-6' : 'relay-main-model';
        check(`${record.name}: only the requested provider model is used`, models.length > 0 && models.every(model => model === expected));
      }
      if (record.name === 'fallback-protected') check('guarded model failure is reported instead of fallback', record.result.at(-1).is_error === true);
      else check(`${record.name}: request succeeds`, record.result.every(result => !result.is_error));
      if (record.hotReloadRequestStart !== undefined) {
        check(`${record.name}: actual user resource reload succeeded`, record.reloadedSkill === true);
        check(`${record.name}: same session continued after user settings changed`, record.requests.length > record.hotReloadRequestStart && record.result.length === 2);
      }
    }
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, onlyCase ? `model-policy-${onlyCase}.json` : 'model-policy-runtime.json'), JSON.stringify({ ok: true, checks, records }, null, 2));
    console.log(JSON.stringify({ ok: true, checks: checks.length, cases: records.length }));
  } finally {
    for (const q of queries) q.close(); server.closeAllConnections(); server.close();
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
  }
})().catch(error => {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'model-policy-runtime-failure.json'), JSON.stringify({ error: error.message, checks, records }, null, 2));
  console.error(error.stack); process.exitCode = 1;
});
