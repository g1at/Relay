'use strict';
// Real bundled Claude SDK, synthetic credentials and loopback HTTP only.
// Kept out of *.test.js: this is an explicit runtime acceptance check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const relay = require('../src/main/sdk/claude-sdk');
const { LiveAsyncAgentTracker, liveResultDisposition } = require('../src/main/live/live-async-agent-tracker');
const { LiveTurnRouter } = require('../src/main/live/live-turn-router');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-provider-runtime-'));
const outputDir = path.join(__dirname, '../.codex-tmp/provider-fix-validation');
const observations = [], checks = [], results = [], lifecycle = [], liveQueries = new Set();
const secrets = ['fixture-relay-api', 'fixture-relay-token', 'fixture-foreign-api', 'fixture-foreign-token'];
let activeCase = '', mcpCalls = 0, subagentCalls = 0;
function check(name, condition) { assert.ok(condition, name); checks.push(name); }
function textOf(value) { return typeof value === 'string' ? value : JSON.stringify(value || ''); }
async function until(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${activeCase}: timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
function sse(res, message, blocks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  function emit(event, payload) { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  blocks.forEach((block, index) => {
    emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text'
      ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    emit('content_block_stop', { type: 'content_block_stop', index });
  });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
  emit('message_stop', { type: 'message_stop' }); res.end();
}
async function server(label) {
  const instance = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":20}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      const isSubagent = textOf(body.system).includes('RELAY_SUBAGENT_FIXTURE');
      observations.push({ case: activeCase, endpoint: label, path: req.url, model: body.model, apiKey: req.headers['x-api-key'] || null,
        authorization: req.headers.authorization || null, subagent: isSubagent, customHeader: req.headers['x-foreign-route'] || null,
        tools: (body.tools || []).map(tool => tool.name), toolResults: (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_result').map(c => ({ error: !!c.is_error, content: textOf(c.content).slice(0, 500) })) : []) });
      if (isSubagent) subagentCalls++;
      const messages = body.messages || [];
      const requestedResources = textOf(messages).includes('RUN_RESOURCE_FIXTURES');
      const toolResults = messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
      const blocks = requestedResources && !isSubagent && !toolResults ? [
        { type: 'tool_use', id: `tool_${randomUUID()}`, name: 'Agent', input: { subagent_type: 'relay-fixture-agent', description: 'Run fixture agent', prompt: 'Reply fixture-agent-ok. Do not use tools.', run_in_background: false } },
        { type: 'tool_use', id: `tool_${randomUUID()}`, name: 'mcp__relay-fixture__echo', input: { value: 'fixture-mcp-ok' } },
      ] : [{ type: 'text', text: isSubagent ? 'fixture-agent-ok' : 'fixture-ok' }];
      const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model, content: blocks,
        stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
      if (body.stream) sse(res, message, blocks);
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); }
    });
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { instance, url: `http://127.0.0.1:${instance.address().port}/anthropic` };
}
function fixtureDirectories(foreignUrl) {
  const configDir = path.join(root, 'config'), cwd = path.join(root, 'workspace');
  fs.mkdirSync(path.join(configDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'skills/relay-fixture-skill'), { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'agents/relay-fixture-agent.md'), '---\nname: relay-fixture-agent\ndescription: Local runtime fixture agent\nmodel: haiku\ntools: Read\n---\nRELAY_SUBAGENT_FIXTURE. Reply fixture-agent-ok only.\n');
  fs.writeFileSync(path.join(configDir, 'skills/relay-fixture-skill/SKILL.md'), '---\nname: relay-fixture-skill\ndescription: Local runtime fixture skill\n---\nReply fixture-skill-ok only.\n');
  const helperMarker = path.join(root, 'helper-was-run');
  const helper = path.join(root, 'auth-helper.cjs');
  fs.writeFileSync(helper, `require('fs').writeFileSync(${JSON.stringify(helperMarker)}, 'unexpected');process.stdout.write('fixture-helper-key');`);
  const settings = { model: 'foreign-model', apiKeyHelper: `"${process.execPath}" "${helper}"`, env: {
    ANTHROPIC_BASE_URL: foreignUrl, ANTHROPIC_API_KEY: secrets[2], ANTHROPIC_AUTH_TOKEN: secrets[3],
    ANTHROPIC_MODEL: 'foreign-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'foreign-fast', ANTHROPIC_DEFAULT_SONNET_MODEL: 'foreign-medium',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'foreign-expert', CLAUDE_CODE_SUBAGENT_MODEL: 'foreign-agent', ANTHROPIC_SMALL_FAST_MODEL: 'foreign-small',
    ANTHROPIC_CUSTOM_HEADERS: 'X-Foreign-Route: unexpected', CLAUDE_CODE_USE_BEDROCK: '1',
  } };
  const settingsFile = path.join(configDir, 'settings.json'); fs.writeFileSync(settingsFile, JSON.stringify(settings));
  return { configDir, cwd, helperMarker, settings, settingsFile };
}
function environment(dirs, apiUrl, token = false) {
  return { CLAUDE_CONFIG_DIR: dirs.configDir, ANTHROPIC_BASE_URL: apiUrl,
    ANTHROPIC_API_KEY: token ? '' : secrets[0], ANTHROPIC_AUTH_TOKEN: token ? secrets[1] : '',
    ANTHROPIC_MODEL: token ? 'relay-token-model' : 'relay-main-model', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'relay-fast-model',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'relay-medium-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'relay-main-model',
    CLAUDE_CODE_GIT_BASH_PATH: process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
}
async function openQuery(sdk, dirs, env, { resume, resources = false } = {}) {
  let wake, ended = false; const queue = [], terminalWaiters = [], terminals = [];
  const router = new LiveTurnRouter(), agents = new LiveAsyncAgentTracker(), tasks = new Map();
  const abortController = new AbortController();
  const options = relay._buildOptions({ cwd: dirs.cwd, model: env.ANTHROPIC_MODEL, runtimeEnv: env, sessionId: resume,
    // An Agent's frontmatter can only select registered tools. It declares Read
    // even though the fixture model never calls it; omitting it here makes the
    // SDK reject that Agent with an empty tool set before any model request.
    tools: resources ? ['Agent', 'Skill', 'Read'] : [], abortController,
    canUseTool: async (name, input) => ['Agent', 'Skill', 'mcp__relay-fixture__echo'].includes(name)
      ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Not a fixture tool' },
    mcpServersFactory: resources ? loaded => ({ 'relay-fixture': loaded.createSdkMcpServer({ name: 'relay-fixture', version: '1.0.0', tools: [
      loaded.tool('echo', 'Local echo fixture', { value: require('zod').z.string() }, async ({ value }) => { mcpCalls++; return { content: [{ type: 'text', text: value }] }; }),
    ] }) }) : undefined,
    onSpawn: child => check(`${activeCase}: credentials absent from child arguments`, secrets.every(secret => !child.spawnargs.join(' ').includes(secret))),
  }, sdk);
  options.maxTurns = 6;
  options.stderr = value => lifecycle.push({ case: activeCase, stderr: value.slice(0, 2000) });
  check(`${activeCase}: host owns provider configuration`, options.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === '1');
  check(`${activeCase}: user resources still enabled`, options.settingSources.includes('user'));
  async function* input() { while (!ended) { if (queue.length) yield queue.shift(); else await new Promise(resolve => wake = resolve); } }
  const q = sdk.query({ prompt: input(), options }); liveQueries.add(q);
  let sessionId;
  const pump = (async () => {
    try { for await (const event of q) {
      if (event.session_id) sessionId = event.session_id;
      if (event.type === 'system' && /task_|error|notification/.test(event.subtype || '')) lifecycle.push({ case: activeCase, event });
      if (event.type === 'system' && event.subtype === 'task_started') tasks.set(event.task_id, { ...event, status: 'running' });
      if (event.type === 'system' && tasks.has(event.task_id)) {
        if (event.subtype === 'task_updated') Object.assign(tasks.get(event.task_id), event.patch);
        if (event.subtype === 'task_notification') Object.assign(tasks.get(event.task_id), event);
      }
      if (event.type === 'result' && event.parent_tool_use_id) continue;
      const owned = router.accept(event);
      if (!owned) continue;
      agents.ingest(owned);
      if (owned.type === 'result') {
        const disposition = liveResultDisposition(owned, agents);
        router.noteResult(disposition, agents.size);
        if (disposition !== 'finish') continue;
        terminals.push(owned); router.end();
        if (terminalWaiters.length) terminalWaiters.shift().resolve(owned);
      }
    } } catch (error) { for (const pending of terminalWaiters.splice(0)) pending.reject(error); if (!ended) throw error; }
  })(); pump.catch(() => {});
  return { q, get sessionId() { return sessionId; },
    async turn(prompt) {
      const before = terminals.length;
      const inputId = randomUUID(); router.begin(inputId); agents.reset();
      const terminal = new Promise((resolve, reject) => terminalWaiters.push({ resolve, reject }));
      queue.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '', uuid: inputId });
      if (wake) { wake(); wake = null; }
      let timer;
      try { const event = await Promise.race([terminal, new Promise((_, reject) => timer = setTimeout(() => { abortController.abort(); reject(new Error(`${activeCase}: turn timed out`)); }, 45000))]);
        check(`${activeCase}: turn ${before + 1} succeeds`, !event.is_error && event.result === 'fixture-ok');
        results.push({ case: activeCase, sessionId: event.session_id, result: event.result, isError: event.is_error }); return event;
      } finally { clearTimeout(timer); }
    },
    async agentCompletion() {
      await until(() => {
        const fixtureTasks = [...tasks.values()].filter(task => task.subagent_type === 'relay-fixture-agent');
        for (const task of fixtureTasks) {
          if (['failed', 'stopped', 'killed'].includes(task.status)) throw new Error(`Fixture Agent ${task.status}: ${task.error || task.summary || task.task_id}`);
        }
        return fixtureTasks.length > 0 && fixtureTasks.every(task => task.status === 'completed');
      }, 'fixture Agent completion');
    },
    async close() { ended = true; if (wake) wake(); q.close(); await pump.catch(() => {}); liveQueries.delete(q); },
  };
}
(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const desired = await server('relay'), foreign = await server('foreign');
  try {
    const dirs = fixtureDirectories(foreign.url), sdk = await relay.loadSdk(), apiEnv = environment(dirs, desired.url);
    activeCase = 'api-key-live';
    const live = await openQuery(sdk, dirs, apiEnv, { resources: true });
    const [agents, commands] = await Promise.all([live.q.supportedAgents(), live.q.supportedCommands()]);
    check('user Agent is discovered', agents.some(agent => textOf(agent).includes('relay-fixture-agent')));
    check('user Skill is discovered', commands.some(command => textOf(command).includes('relay-fixture-skill')));
    await live.turn('RUN_RESOURCE_FIXTURES');
    // Completion is authoritative; fail with the actual SDK task error instead
    // of treating an async launch acknowledgement as proof of an Agent request.
    await live.agentCompletion();
    check('user Agent actually called its mapped model', subagentCalls > 0 && observations.some(o => o.subagent && o.model === 'relay-fast-model'));
    check('in-process MCP tool actually executed', mcpCalls > 0);
    const mcpStatus = await live.q.mcpServerStatus();
    check('in-process MCP remains connected', mcpStatus.some(s => s.name === 'relay-fixture' && s.status === 'connected'));
    dirs.settings.env.ANTHROPIC_BASE_URL = foreign.url + '/reloaded'; dirs.settings.env.ANTHROPIC_API_KEY = 'fixture-foreign-reloaded';
    dirs.settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'foreign-reloaded-fast';
    fs.writeFileSync(dirs.settingsFile, JSON.stringify(dirs.settings));
    // A second harmless skill ensures a real resource refresh occurs while the
    // same live process retains its provider, rather than merely delaying once.
    fs.mkdirSync(path.join(dirs.configDir, 'skills/relay-reloaded-skill'));
    fs.writeFileSync(path.join(dirs.configDir, 'skills/relay-reloaded-skill/SKILL.md'), '---\nname: relay-reloaded-skill\ndescription: Reload fixture\n---\nReply fixture-only.\n');
    await new Promise(resolve => setTimeout(resolve, 1500)); await live.q.reloadSkills();
    check('skills can reload during the same session', (await live.q.supportedCommands()).some(c => textOf(c).includes('relay-reloaded-skill')));
    await live.turn('Reply fixture-ok after settings reload.');
    const sessionId = live.sessionId; check('native session ID is retained', !!sessionId); await live.close();
    activeCase = 'native-resume'; const resumed = await openQuery(sdk, dirs, apiEnv, { resume: sessionId });
    await resumed.turn('Reply fixture-ok after resume.'); check('native history resumes same session', resumed.sessionId === sessionId); await resumed.close();
    activeCase = 'bearer-live'; const token = await openQuery(sdk, dirs, environment(dirs, desired.url, true));
    await token.turn('Reply fixture-ok with bearer authentication.'); await token.close();
    activeCase = 'text-only'; const text = await relay.runText({ prompt: 'Reply fixture-ok for the text helper.', cwd: dirs.cwd, model: apiEnv.ANTHROPIC_MODEL, runtimeEnv: apiEnv, tools: [], timeoutMs: 30000 });
    check('lightweight text helper keeps Relay provider', text === 'fixture-ok');
    activeCase = 'one-shot';
    const oneShotResult = await new Promise((resolve, reject) => {
      let handle;
      const timer = setTimeout(() => { handle?.kill(); reject(new Error('One-shot fixture timed out')); }, 30000);
      ({ handle } = relay.runOneShot({ prompt: 'Reply fixture-ok for the scheduled wrapper.', cwd: dirs.cwd,
        model: apiEnv.ANTHROPIC_MODEL, runtimeEnv: apiEnv, tools: [],
        onEvent: event => { if (event.type === 'job-done') { clearTimeout(timer); resolve(event); } },
      }));
    });
    check('one-shot wrapper keeps Relay provider', oneShotResult.exitCode === 0 && oneShotResult.finalResult?.result === 'fixture-ok');
    check('no request reached foreign provider', observations.length > 0 && observations.every(o => o.endpoint === 'relay'));
    check('API-key routes never mix in a bearer token', observations.filter(o => o.case !== 'bearer-live').every(o => o.apiKey === secrets[0] && o.authorization === null));
    check('bearer route never mixes in an API key', observations.filter(o => o.case === 'bearer-live').length > 0 && observations.filter(o => o.case === 'bearer-live').every(o => o.authorization === `Bearer ${secrets[1]}` && o.apiKey === null));
    check('settings-sourced custom headers are ignored', observations.every(o => !o.customHeader));
    check('settings-sourced model and aliases never override the route', observations.every(o => o.model === (o.subagent ? 'relay-fast-model' : o.case === 'bearer-live' ? 'relay-token-model' : 'relay-main-model')));
    check('settings-sourced auth helper never executes', !fs.existsSync(dirs.helperMarker));
    const result = { ok: true, checkCount: checks.length, checks, observations, results, mcpCalls, subagentCalls, realSdk: true, realProvider: false };
    fs.writeFileSync(path.join(outputDir, 'runtime-smoke.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: true, checks: checks.length, requests: observations.length, mcpCalls, subagentCalls }));
  } finally {
    for (const q of liveQueries) q.close();
    for (const s of [desired, foreign]) { s.instance.closeAllConnections(); s.instance.close(); }
    // Claude may still hold a Windows transcript handle briefly after close().
    try { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (error) { console.warn('Fixture cleanup deferred:', error.code, root); }
  }
})().catch(error => {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'runtime-smoke-failure.json'), JSON.stringify({ error: error.message, checks, observations, results, lifecycle }, null, 2));
  console.error(error.stack); process.exitCode = 1;
});
