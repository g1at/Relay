'use strict';
// Real Relay Query adapter + bundled SDK/CLI. Synthetic credentials and isolated
// transcripts; every model request is served by the loopback fixture below.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const relay = require('../claude-sdk');
const { LiveTurnRouter } = require('../live-turn-router');
const { normalizeSupplement, submitLiveSupplement, observeSupplement } = require('../live-supplement-input');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-continuity-'));
const cwd = path.join(base, 'workspace'), config = path.join(base, 'config');
fs.mkdirSync(cwd); fs.mkdirSync(config); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const output = path.join(__dirname, '../.codex-tmp/sdk-conversation-continuity');
fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'],
  cli: relay.bundledClaudeVersion(), platform: process.platform, checks: [], requests: [], lifecycle: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, session, release, nativeId, holdNext = false, replies = [], done = 0;
function check(name, value) { assert.ok(value, name); report.checks.push(name); }
async function until(test, label) {
  const end = Date.now() + 30000;
  while (!test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await sleep(20); }
}
function send(res, body, text, hold) {
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', { type: 'message_start', message });
  emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  let sent = false;
  const finish = () => {
    if (sent) return; sent = true;
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
    emit('message_stop', { type: 'message_stop' }); res.end();
  };
  if (hold) release = finish; else finish();
}
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
    if (req.url.includes('/count_tokens')) { res.end('{"input_tokens":20}'); return; }
    if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
    try {
      const body = JSON.parse(raw), messages = body.messages || [], index = report.requests.length;
      const serialized = JSON.stringify(messages);
      report.requests.push({ index, authorized: req.headers['x-api-key'] === 'synthetic-continuity-key', model: body.model,
        firstUser: serialized.includes('FIRST_USER_FIXTURE'), firstAssistant: messages.some(item => item.role === 'assistant' && JSON.stringify(item.content).includes('FIRST_ASSISTANT_FIXTURE')),
        secondUser: serialized.includes('SECOND_USER_FIXTURE'), secondAssistant: messages.some(item => item.role === 'assistant' && JSON.stringify(item.content).includes('SECOND_ASSISTANT_FIXTURE')),
        revised: serialized.includes('REVISED_REQUIREMENT_FIXTURE'), doneBefore: done });
      const text = index === 0 ? 'FIRST_ASSISTANT_FIXTURE' : index === 1 ? 'SECOND_ASSISTANT_FIXTURE'
        : serialized.includes('REVISED_REQUIREMENT_FIXTURE') ? 'REVISED_ASSISTANT_FIXTURE' : 'RESUMED_ASSISTANT_FIXTURE';
      const hold = holdNext; holdNext = false; send(res, body, text, hold);
    } catch (error) { report.serverError = String(error); res.destroy(error); }
  });
});
function create(sessionId) {
  const router = new LiveTurnRouter();
  session = { busy: false, dead: false, turnRouter: router, supplementInputs: new Map(), jobId: null };
  const owner = session;
  child = owner.child = relay.createLiveSession({ cwd, sessionId, model: 'fixture-model', tools: [],
    runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, mcpServers: {} } },
    runtimeEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-continuity-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_MODEL: 'fixture-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
      ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    onMessage(raw) {
      if (raw.type === 'system' && raw.subtype === 'init') nativeId = raw.session_id;
      if (raw.type === 'command_lifecycle') report.lifecycle.push({ id: raw.command_uuid, state: raw.state });
      const event = router.accept(raw); if (!event) return;
      observeSupplement(owner, event, () => {});
      if (event.type !== 'result') return;
      const pending = router.resultPendingSupplementCount(event);
      replies.push({ ...event, relay_pending_inputs: pending });
      if (!event.is_error && event.subtype === 'success' && !pending && !event.queued_turn_count) {
        done++; owner.busy = false; router.end();
      }
    }, onExit() { owner.dead = true; },
  });
}
async function turn(prompt) {
  session.jobId = randomUUID(); session.busy = true; session.turnRouter.begin(session.jobId);
  const before = done; check(prompt + ': accepted', child.push(prompt, { uuid: session.jobId }));
  await until(() => done > before, prompt + ': completed');
}
(async () => {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    create();
    await turn('FIRST_USER_FIXTURE');
    await turn('SECOND_USER_FIXTURE');
    check('a live second turn carries both previous user and assistant roles', report.requests[1].firstUser && report.requests[1].firstAssistant);
    const savedId = nativeId; check('the live Query exposes a stable native session UUID', /^[\da-f-]{36}$/i.test(savedId));
    await child.kill(); create(savedId);
    await turn('RESUMED_USER_FIXTURE');
    check('resuming uses the original SDK transcript identity', nativeId === savedId);
    check('a recreated Query restores both earlier user and assistant turns', report.requests[2].firstUser && report.requests[2].firstAssistant
      && report.requests[2].secondUser && report.requests[2].secondAssistant);
    const original = randomUUID(), supplement = randomUUID(), before = done, beforeReplies = replies.length;
    session.jobId = original; session.busy = true; session.turnRouter.begin(original); holdNext = true;
    check('streaming turn is accepted', child.push('START_STEERING_FIXTURE', { uuid: original }));
    await until(() => release, 'open output stream');
    const input = normalizeSupplement({ messageId: supplement, prompt: 'REVISED_REQUIREMENT_FIXTURE' });
    check('mid-stream requirement enters the same Query and run', submitLiveSupplement({ session, jobId: original, input, persist() {}, emit() {} }).ok);
    await until(() => report.lifecycle.some(event => event.id === supplement && event.state === 'queued'), 'native queue acknowledgement');
    check('queue acknowledgement alone does not claim model consumption', input.status === 'queued' && done === before);
    release(); await until(() => done > before, 'revised task completion');
    check('the revised requirement occurs in a real subsequent model request', report.requests.at(-1).revised);
    check('old result cannot complete while the new requirement is unanswered', report.requests.at(-1).doneBefore === before);
    check('the revised run completes once only with the revised answer', done === before + 1 && replies.at(-1).result === 'REVISED_ASSISTANT_FIXTURE');
    check('the SDK supplies actual consumed-input evidence', input.status === 'applied' && replies.at(-1).user_message_uuids.includes(supplement));
    check('steering produces no interruption or process restart', !session.dead && nativeId === savedId
      && replies.slice(beforeReplies).every(event => !/^aborted_/.test(String(event.terminal_reason || ''))));
    check('all model calls stayed on synthetic credentials and model', report.requests.every(item => item.authorized && item.model === 'fixture-model'));
    report.ok = true;
  } catch (error) { report.ok = false; report.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    release?.(); if (child) await child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (let attempt = 0; attempt < 30; attempt++) { try { fs.rmSync(base, { recursive: true, force: true }); report.cleanedUp = true; break; } catch (_) { await sleep(100); } }
    if (!report.cleanedUp) { report.ok = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(output, `runtime-${process.platform}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, requests: report.requests.length, ...(report.error ? { error: report.error } : {}) }));
  }
})();
