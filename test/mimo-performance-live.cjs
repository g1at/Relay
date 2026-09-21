'use strict';
// Explicit opt-in integration probe. Reads only the configured MiMo credential,
// keeps it in memory, sends synthetic prompts, and writes sanitized metrics.
// Run with Windows Electron: electron test/mimo-performance-live.cjs --live-mimo
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const { randomUUID, createHash } = require('node:crypto');
const zlib = require('node:zlib');
const relay = require('../claude-sdk');
const { dispatchLiveInput } = require('../live-mcp-dispatch');
const { LiveTurnRouter } = require('../live-turn-router');
const { LiveAsyncAgentTracker, liveResultDisposition } = require('../live-async-agent-tracker');
const { normalizeSupplement, submitLiveSupplement, observeSupplement } = require('../live-supplement-input');
if (!process.argv.includes('--live-mimo') || process.platform !== 'win32') throw Error('Requires explicit --live-mimo and Windows Electron.');
const output = path.join(__dirname, '../.codex-tmp/mimo-performance');
fs.mkdirSync(output, { recursive: true });
const extendedMode = process.argv.includes('--extended');
const imageOnly = extendedMode && process.argv.includes('--extended-image-only');
// Explicit capability comparison affects only this disposable image probe.
const imageModelOverride = process.argv.find(arg => arg.startsWith('--image-model='))?.slice(14);
if (imageModelOverride !== undefined && (!imageOnly || imageModelOverride !== 'mimo-v2.5')) {
  throw Error('--image-model=mimo-v2.5 is supported only for the isolated image probe');
}
const suffix = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'baseline';
if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(suffix)) throw Error('Invalid report label');
const profileRoot = path.join(os.tmpdir(), 'relay-mimo-profile-' + randomUUID());
fs.mkdirSync(profileRoot);
// Local cleanup inventory is deliberately separate from the sanitized report.
const cleanupFile = path.join(output, 'private-cleanup-manifest.json');
const cleanup = fs.existsSync(cleanupFile) ? JSON.parse(fs.readFileSync(cleanupFile, 'utf8')) : { profiles: [] };
cleanup.profiles.push({ label: suffix, path: profileRoot, createdAt: new Date().toISOString(), cleanupPending: true });
fs.writeFileSync(cleanupFile, JSON.stringify(cleanup, null, 2));
const isolatedElectron = path.join(profileRoot, 'electron');
fs.mkdirSync(isolatedElectron);
// Chromium encrypts safeStorage values with this OS-protected profile key.
// Copy only its encrypted key into the disposable profile, never the live app
// preferences/history or any plaintext credential.
const localState = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Relay', 'Local State'), 'utf8'));
if (localState.os_crypt) fs.writeFileSync(path.join(isolatedElectron, 'Local State'), JSON.stringify({ os_crypt: localState.os_crypt }));
app.setPath('userData', isolatedElectron);
const report = { at: new Date().toISOString(), platform: process.platform, sdk: '0.3.266', model: '',
  scenarios: [], requests: [], errors: [], realProvider: true, syntheticInputsOnly: true, userSettingsWritten: false };
if (extendedMode) report.limits = { realApiRequests: imageOnly ? (imageModelOverride ? 4 : 2) : 8, scenarioTimeoutMs: 60000 };
if (imageModelOverride) report.isolatedModelOverride = imageModelOverride;
const save = () => fs.writeFileSync(path.join(output, 'live-' + suffix + '.json'), JSON.stringify(report, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let proxy, credential, profile, active, child, owner, lastBody, sessionId, syntheticImageHash;
let realApiRequestCount = 0;
const connections = new Set();
const pool = new https.Agent({ keepAlive: true });
function safeFailure(error) { return { code: error?.code || null, name: error?.name || 'Error' }; }
function sendUpstream(body, relative, headers, targetResponse, scenario) {
  const start = Date.now();
  const entry = { scenario: scenario.name, startedMs: start - scenario.startedAt,
    requestBytes: Buffer.byteLength(JSON.stringify(body)), messageCount: body.messages?.length || 0,
    toolCount: body.tools?.length || 0, thinking: body.thinking || null, maxTokens: body.max_tokens,
    systemCharacters: JSON.stringify(body.system || '').length, model: body.model };
  entry.hasSyntheticMcpResult = (body.messages || []).some(message => Array.isArray(message.content)
    && message.content.some(block => block.type === 'tool_result' && JSON.stringify(block.content).includes('RELAY_MCP_42')));
  if (extendedMode) {
    const images = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'image');
    entry.imageBlocks = images.length;
    entry.imageMediaTypes = images.map(block => block.source?.media_type || null);
    entry.syntheticImagePayloadMatched = images.some(block => block.source?.type === 'base64'
      && createHash('sha256').update(Buffer.from(block.source.data, 'base64')).digest('hex') === syntheticImageHash);
    entry.structuredOutputRequested = !!(body.output_config?.format || body.output_format
      || body.tools?.some(tool => tool.name === 'StructuredOutput'));
  }
  report.requests.push(entry);
  if (extendedMode && (realApiRequestCount >= report.limits.realApiRequests || !scenario || scenario.closed
      || Date.now() - scenario.startedAt >= report.limits.scenarioTimeoutMs)) {
    entry.blockedBeforeUpstream = true;
    entry.error = { code: realApiRequestCount >= report.limits.realApiRequests ? 'REQUEST_BUDGET_EXHAUSTED' : 'SCENARIO_CLOSED', name: 'Error' };
    targetResponse?.writeHead(400, { 'content-type': 'application/json' });
    targetResponse?.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: entry.error.code } }));
    save(); return Promise.resolve(entry);
  }
  report.realApiRequestCount = ++realApiRequestCount;
  return new Promise((resolve, reject) => {
    const url = new URL(profile.baseUrl.replace(/\/$/, '') + relative);
    if (url.protocol !== 'https:' || url.origin !== new URL(profile.baseUrl).origin) return reject(Error('Unexpected destination'));
    const wire = JSON.stringify(body);
    const auth = profile.authMode === 'auth-token' ? { authorization: 'Bearer ' + credential } : { 'x-api-key': credential };
    const request = https.request(url, { method: 'POST', agent: pool,
      headers: { ...headers, ...auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire), 'accept-encoding': 'identity' } }, response => {
      entry.status = response.statusCode; entry.headersMs = Date.now() - start;
      targetResponse?.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] || 'text/event-stream' });
      let buffer = '', errorBody = '';
      response.on('data', chunk => {
        if (extendedMode && response.statusCode >= 400 && errorBody.length < 16384) errorBody += chunk.toString();
        if (entry.firstByteMs == null) entry.firstByteMs = Date.now() - start;
        targetResponse?.write(chunk); buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const event = JSON.parse(line.slice(5));
            if (event.type === 'content_block_delta' && entry.firstDeltaMs == null) entry.firstDeltaMs = Date.now() - start;
            if (event.delta?.type === 'text_delta' && entry.firstTextMs == null) entry.firstTextMs = Date.now() - start;
            if (event.type === 'message_start' && event.message?.usage) entry.usage = event.message.usage;
            if (event.usage) entry.usage = { ...entry.usage, ...event.usage };
          } catch (_) {}
        }
      });
      response.on('end', () => {
        if (errorBody) {
          try {
            const parsed = JSON.parse(errorBody), error = parsed.error || parsed;
            entry.providerErrorType = typeof error.type === 'string' && /^[a-z0-9_-]{1,80}$/i.test(error.type) ? error.type : null;
            entry.providerErrorCode = typeof error.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(error.code) ? error.code : null;
            const message = typeof error.message === 'string' ? error.message : '';
            entry.providerErrorClassification = /(?:image|vision|图片|图像)/i.test(message)
              && /(?:not support|unsupported|不支持|not available|unavailable)/i.test(message) ? 'image-not-supported'
              : /(?:model|模型)/i.test(message) && /(?:not found|not exist|不存在)/i.test(message) ? 'model-not-found'
              : /(?:not found|not exist|不存在)/i.test(message) ? 'resource-not-found' : 'unclassified';
          } catch (_) { entry.providerErrorClassification = 'non-json-error-response'; }
        }
        entry.totalMs = Date.now() - start; targetResponse?.end(); save(); resolve(entry);
      });
      response.on('error', reject);
    });
    connections.add(request);
    const deadline = extendedMode ? setTimeout(() => request.destroy(Object.assign(Error('scenario timeout'), { code: 'SCENARIO_TIMEOUT' })),
      Math.max(1, 60000 - (Date.now() - scenario.startedAt))) : null;
    request.on('close', () => { connections.delete(request); if (deadline) clearTimeout(deadline); });
    request.setTimeout(extendedMode ? Math.max(1, 60000 - (Date.now() - scenario.startedAt)) : 90000,
      () => request.destroy(Object.assign(Error('provider timeout'), { code: 'PROVIDER_TIMEOUT' })));
    request.on('error', error => { entry.error = safeFailure(error); targetResponse?.destroy(); save(); reject(error); });
    request.end(wire);
  });
}
async function until(test, timeout = 120000) {
  const end = Date.now() + timeout;
  while (!test()) { if (Date.now() > end) throw Object.assign(Error('Scenario timeout'), { code: 'SCENARIO_TIMEOUT' }); await sleep(20); }
}
function isolatedRuntime() {
  const cwd = path.join(profileRoot, 'workspace'), config = path.join(profileRoot, 'sdk');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), '{}');
  return { cwd, runtimeEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.address().port}`,
    ANTHROPIC_API_KEY: 'relay-local-timing-proxy', ANTHROPIC_MODEL: report.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' } };
}
function createSession(extra = {}) {
  const { cwd, runtimeEnv } = isolatedRuntime();
  const router = new LiveTurnRouter();
  owner = { busy: false, dead: false, turnRouter: router, supplementInputs: new Map(), asyncAgentTracker: new LiveAsyncAgentTracker() };
  const currentOwner = owner;
  child = currentOwner.child = relay.createLiveSession({ cwd, model: report.model, tools: [],
    runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, mcpServers: {} } },
    runtimeEnv,
    ...extra,
    onMessage(raw) {
      if (raw.type === 'system' && raw.subtype === 'init') sessionId = raw.session_id;
      const event = router.accept(raw); if (!event || !active || !currentOwner.busy) return;
      if (extendedMode && event.type === 'active_goal') {
        (active.activeGoalEvents ||= []).push({ active: !!event.value, conditionMatches: event.value?.condition === active.expectedGoalCondition });
      }
      observeSupplement(currentOwner, event, () => {});
      currentOwner.asyncAgentTracker.ingest(event);
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
        active.firstDeltaMs ??= Date.now() - active.startedAt;
        if (event.event.delta?.type === 'text_delta') active.firstTextMs ??= Date.now() - active.startedAt;
      }
      if (event.type === 'assistant') for (const block of event.message?.content || []) {
        if (block.type === 'tool_use') (active.tools ||= []).push(block.name);
      }
      if (event.type === 'result') {
        active.resultCount = (active.resultCount || 0) + 1;
        const disposition = liveResultDisposition(event, currentOwner.asyncAgentTracker);
        router.noteResult(disposition, currentOwner.asyncAgentTracker.size);
        if (disposition !== 'finish' || router.resultPendingSupplementCount(event) || event.queued_turn_count) return;
        active.totalMs = Date.now() - active.startedAt;
        active.result = { success: event.subtype === 'success' && !event.is_error, subtype: event.subtype,
          outputCharacters: event.result?.length || 0, apiDurationMs: event.duration_api_ms, turns: event.num_turns,
          reason: event.terminal_reason };
        active.resultText = event.result || '';
        currentOwner.busy = false; router.end();
      }
    },
    onExit(code) { currentOwner.dead = true; if (active && currentOwner.busy) { active.exitCode = code; currentOwner.busy = false; } },
  });
  return cwd;
}
async function runTurn(name, prompt, { files, mode = { kind: 'default' }, fresh = false, extra = {}, during, verify, prepareOptions = {} } = {}) {
  if (fresh && child) await child.kill();
  const item = active = { name, startedAt: Date.now() }; report.scenarios.push(item);
  if (!child || fresh) createSession(extra);
  const id = randomUUID(); owner.busy = true; owner.jobId = id; owner.turnRouter.begin(id);
  dispatchLiveInput({ session: owner, jobId: id, prompt, files,
    prepareInput: async () => {
      const prepared = await child.prepareExecutionMode(mode, { permissionMode: 'default', contextPrompt: prompt, ...prepareOptions });
      if (extendedMode && mode.kind === 'goal') {
        item.expectedGoalCondition = prepareOptions.goalCondition;
        item.nativeGoalCommandPrepared = prepared.prompt === `/goal ${prepareOptions.goalCondition}`;
        item.preparedGoalConditionMatched = prepared.goalCondition === prepareOptions.goalCondition;
      }
      return prepared;
    },
    loadServers: () => ({}), isSessionCurrent: () => true,
    onTiming: timing => { item.preparation = timing; save(); },
    onStatus: state => { item.mcpReady = state.ok; },
    onFailure: error => { item.failedPreparation = true; item.preparationError = safeFailure(error); owner.busy = false; },
  });
  if (during) await during(item);
  await until(() => !owner.busy, extendedMode ? Math.max(1, 60000 - (Date.now() - item.startedAt)) : 120000);
  const text = item.resultText || ''; delete item.resultText;
  item.ok = verify ? !!verify(text, item) : !!item.result?.success; save();
  console.log(JSON.stringify({ name, ok: item.ok, preparation: item.preparation, firstTextMs: item.firstTextMs, totalMs: item.totalMs }));
  return text;
}
async function features() {
  const cwd = path.join(profileRoot, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(cwd, 'relay-synthetic-note.txt');
  const permissions = [];
  const canUseTool = async (name, input) => {
    permissions.push(name);
    if (name === 'AskUserQuestion') return { behavior: 'allow', updatedInput: { ...input,
      answers: Object.fromEntries((input.questions || []).map(q => [q.question, q.options?.[0]?.label || '测试通过'])) } };
    if (['Read', 'Write', 'Edit'].includes(name)) {
      if (path.resolve(input.file_path || '') !== file) return { behavior: 'deny', message: '只操作指定的合成测试文件。' };
      return { behavior: 'allow', updatedInput: input };
    }
    if (['ToolSearch', 'Agent', 'Task', 'mcp__relay_probe__echo'].includes(name)) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: '此集成测试没有授权其他操作。' };
  };
  const extra = { tools: ['Read', 'Write', 'Edit', 'AskUserQuestion', 'Agent', 'ToolSearch'], canUseTool,
    appendSystemPrompt: 'This is a synthetic Relay integration test. Only use the explicitly requested fixture tool or file. Keep final answers brief.',
    runtimePolicy: { settingSources: [], options: { strictMcpConfig: true, maxTurns: 6 } },
    mcpPermissionOverrides: { relay_probe: 'default' },
    mcpServersFactory: sdk => ({ relay_probe: sdk.createSdkMcpServer({ name: 'relay_probe', version: '1.0.0', tools: [
      sdk.tool('echo', 'Returns exactly the supplied synthetic test marker.', { value: require('zod').z.string() }, async ({ value }) => {
        active.mcpExecutions = (active.mcpExecutions || 0) + 1;
        return { content: [{ type: 'text', text: value }] };
      }),
    ] }) }),
  };
  await runTurn('preset-with-tools-short', '这是合成测试，不使用工具，只回复：你好。', { fresh: true, extra });
  await runTurn('write-read-delivery', `使用Write工具将RELAY_SYNTHETIC_42写入 ${file}，再使用Read读回，只回复读到的标记。`, {
    verify: (text, state) => state.result?.success && fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('RELAY_SYNTHETIC_42')
      && state.tools?.includes('Write') && state.tools?.includes('Read') && text.includes('RELAY_SYNTHETIC_42'),
  });
  await runTurn('mcp-permission-roundtrip', '请使用mcp__relay_probe__echo工具（必要时先ToolSearch），传入value=RELAY_MCP_42，最后只回复工具返回值。', {
    verify: (text, state) => {
      state.semanticMarkerMatched = text.includes('RELAY_MCP_42');
      state.toolResultEnteredModelRequest = report.requests.some(request => request.scenario === state.name && request.hasSyntheticMcpResult);
      return state.result?.success && state.mcpExecutions === 1 && state.toolResultEnteredModelRequest;
    },
  });
  await runTurn('ask-user-question', '请实际调用AskUserQuestion工具询问合成选择题：测试结果是正常还是异常？收到选择之后简短复述。', {
    verify: (_text, state) => state.result?.success && state.tools?.includes('AskUserQuestion'),
  });
  await runTurn('subagent', '请实际调用Agent工具创建一个general-purpose子智能体。子任务只需要回复合成标记RELAY_AGENT_42，禁止文件或其他工具操作。收到子智能体答复后原样回复。', {
    verify: (text, state) => state.result?.success && state.tools?.some(name => ['Agent', 'Task'].includes(name)) && text.includes('RELAY_AGENT_42'),
  });
  await runTurn('plan-mode', '给出验证一个纯本地文本文件的两步计划即可，不要执行也不要退出计划模式。', { mode: { kind: 'plan' },
    verify: (_text, state) => state.result?.success && !(state.tools || []).some(name => ['Write', 'Edit'].includes(name)),
  });
  await runTurn('midstream-supplement', '请用约200字介绍软件测试的用途，不使用工具。', {
    during: async item => {
      await until(() => item.firstDeltaMs != null || !owner.busy);
      if (!owner.busy) { item.supplementTooLate = true; return; }
      const input = normalizeSupplement({ messageId: randomUUID(), prompt: '补充要求：最后的回复必须包含新的合成标记 RELAY_STEER_42，请简短回复。' });
      item.supplementQueued = submitLiveSupplement({ session: owner, jobId: owner.jobId, input, persist() {}, emit() {} }).ok;
    },
    verify: (text, state) => state.result?.success && state.supplementQueued && text.includes('RELAY_STEER_42'),
  });
  await runTurn('pause', '请写一篇较长的软件测试介绍，不使用工具。', {
    during: async item => { await until(() => item.firstDeltaMs != null || !owner.busy); if (owner.busy) { item.interruptSent = true; await child.interrupt(); } },
    verify: (_text, state) => state.interruptSent && /^aborted_/.test(state.result?.reason || ''),
  });
  await runTurn('continue-after-pause', '不用写长文了，只回复：暂停后恢复正常。');
  report.permissionCallbacks = permissions;
}
function solidColorPng() {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, payload) => {
    const kind = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(payload.length); checksum.writeUInt32BE(crc32(Buffer.concat([kind, payload])));
    return Buffer.concat([length, kind, payload, checksum]);
  };
  const width = 48, height = 48;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // RGB, eight bits per component.
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * (width * 3 + 1) + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function extended() {
  report.scope = imageOnly ? `Isolated image transport and recognition probe; ${report.limits.realApiRequests}-request budget.`
    : 'Four additional native SDK scenarios; previous nine feature probes are not repeated.';
  const runtimePolicy = { settingSources: [], options: { strictMcpConfig: true, mcpServers: {}, maxTurns: 3 } };
  // A failing capability does not suppress evidence from the remaining probes.
  const probe = async (name, run) => {
    if (child) { await child.kill(); child = null; }
    const before = report.scenarios.length;
    try { await run(); }
    catch (error) {
      if (report.scenarios.length === before) {
        active = { name, startedAt: Date.now() }; report.scenarios.push(active);
      }
      active.ok = false; active.error = safeFailure(error);
      if (owner) owner.busy = false;
      if (child) { await child.kill(); child = null; }
    } finally {
      const item = report.scenarios.at(-1);
      item.totalMs ??= Date.now() - item.startedAt;
      delete item.resultText; delete item.expectedGoalCondition;
      item.closed = true;
      item.realApiRequests = report.requests.filter(entry => entry.scenario === name && !entry.blockedBeforeUpstream).length;
      save(); console.log(JSON.stringify({ name, ok: item.ok, totalMs: item.totalMs, realApiRequests: item.realApiRequests, error: item.error }));
    }
  };
  if (!imageOnly) await probe('native-goal-completion', () => runTurn('native-goal-completion',
    '这是隔离的合成验收任务。不访问文件、不调用工具。计算六乘七，并在最终答复中包含 RELAY_GOAL_42=42。', {
      fresh: true, mode: { kind: 'goal' }, extra: { tools: [], runtimePolicy },
      prepareOptions: { goalCondition: '已正确计算六乘七，并在最终答复中包含 RELAY_GOAL_42=42。', goalExplicit: true, startupTimeoutMs: 45000 },
      verify: (text, state) => {
        state.semanticMarkerMatched = text.includes('RELAY_GOAL_42=42');
        state.actualModelTurnConfirmed = state.result?.turns > 0 && state.result?.apiDurationMs > 0;
        return state.result?.success && state.nativeGoalCommandPrepared && state.preparedGoalConditionMatched
          && state.actualModelTurnConfirmed && state.semanticMarkerMatched;
      },
    }));
  const imagePath = path.join(isolatedRuntime().cwd, 'synthetic-color.png');
  const image = solidColorPng(); fs.writeFileSync(imagePath, image);
  syntheticImageHash = createHash('sha256').update(image).digest('hex');
  await probe('synthetic-image-attachment', () => runTurn('synthetic-image-attachment',
    '查看附件图片。图片的主体是什么颜色？只回复一个中文颜色名称，不要使用任何工具。', {
      fresh: true, extra: { tools: [], runtimePolicy },
      files: [{ path: imagePath, name: 'synthetic-color.png', ext: 'png', size: image.length }],
      verify: (text, state) => {
        const requests = report.requests.filter(entry => entry.scenario === state.name && !entry.blockedBeforeUpstream);
        state.imageTransportConfirmed = requests.some(entry => entry.imageBlocks > 0 && entry.imageMediaTypes.includes('image/png')
          && entry.syntheticImagePayloadMatched);
        state.modelColorCorrect = /^(?:红(?:色)?|red)[。.!！]?$/i.test(text.trim());
        state.answerCharacters = text.trim().length;
        return state.result?.success && state.imageTransportConfirmed && state.modelColorCorrect;
      },
    }));
  if (imageOnly) return;
  await probe('native-structured-output', async () => {
    const item = active = { name: 'native-structured-output', startedAt: Date.now() }; report.scenarios.push(item);
    const result = await relay.runStructured({ ...isolatedRuntime(), model: report.model, runtimePolicy, timeoutMs: 55000,
      prompt: '合成结构化输出测试：label 为 relay，count 为整数 3，ready 为布尔 true。通过要求的结构化输出机制返回这三个字段。',
      schema: { type: 'object', properties: { label: { type: 'string' }, count: { type: 'integer' }, ready: { type: 'boolean' } },
        required: ['label', 'count', 'ready'], additionalProperties: false },
      validate: value => ({ success: !!value && value.label === 'relay' && value.count === 3 && value.ready === true
        && Object.keys(value).length === 3, data: value }),
    });
    item.nativeStructuredResultAccepted = true; // runStructured rejects absent result.structured_output; no text scraping.
    item.schemaAndValuesValid = result.label === 'relay' && result.count === 3 && result.ready === true && Object.keys(result).length === 3;
    item.structuredRequestConfirmed = report.requests.some(entry => entry.scenario === item.name && entry.structuredOutputRequested);
    item.ok = item.nativeStructuredResultAccepted && item.schemaAndValuesValid && item.structuredRequestConfirmed;
  });
  await probe('plain-text-title', async () => {
    const item = active = { name: 'plain-text-title', startedAt: Date.now() }; report.scenarios.push(item);
    const title = (await relay.runText({ ...isolatedRuntime(), model: report.model, runtimePolicy, tools: [], timeoutMs: 55000,
      prompt: '请为这段合成对话生成一个简短的中文标题：用户希望统计本地文件夹中的文件数量，助手交付了统计脚本。只输出 4 至 12 字的标题，不要引号、Markdown、前缀或解释。',
    })).trim();
    item.outputCharacters = title.length;
    item.plainTextFormatValid = title.length >= 4 && title.length <= 12 && !/[\r\n`#*\[\]"“”]/.test(title);
    item.titleRelevanceMatched = /文件/.test(title) && /统计|计数|数量/.test(title);
    item.completedProviderResponse = report.requests.some(entry => entry.scenario === item.name && entry.status === 200 && entry.totalMs != null);
    item.ok = item.plainTextFormatValid && item.titleRelevanceMatched && item.completedProviderResponse && Date.now() - item.startedAt < 55000;
  });
}
(async () => {
  await app.whenReady();
  try {
    report.stage = 'read-config';
    const data = path.join(process.env.APPDATA, 'Relay');
    const profiles = JSON.parse(fs.readFileSync(path.join(data, 'provider-profiles.json'), 'utf8')).profiles;
    profile = profiles.find(value => value.name === 'MiMo' && value.enabled !== false);
    if (!profile) throw Object.assign(Error('MiMo not found'), { code: 'NO_MIMO_PROFILE' });
    const vault = JSON.parse(fs.readFileSync(path.join(data, 'relay-secrets.json'), 'utf8'));
    const entry = vault.records[profile.credentialRef];
    report.stage = 'decrypt-credential';
    credential = safeStorage.decryptString(Buffer.from(entry.value, 'base64'));
    report.stage = 'start-proxy';
    report.model = imageModelOverride || profile.models.sonnet || profile.models.haiku || profile.models.opus;
    proxy = http.createServer((request, response) => {
      if (request.headers['x-api-key'] !== 'relay-local-timing-proxy') { response.writeHead(403); response.end(); return; }
      if (request.url.includes('count_tokens')) { response.end('{"input_tokens":20}'); return; }
      if (!/^\/v1\/messages(?:\?|$)/.test(request.url)) { response.writeHead(404); response.end('{}'); return; }
      let raw = ''; request.on('data', chunk => raw += chunk);
      request.on('end', () => {
        try {
          const body = JSON.parse(raw); lastBody = body;
          sendUpstream(body, request.url, { 'anthropic-version': request.headers['anthropic-version'] || '2023-06-01',
            ...(request.headers['anthropic-beta'] ? { 'anthropic-beta': request.headers['anthropic-beta'] } : {}) }, response, active)
            .catch(error => report.errors.push(safeFailure(error)));
        } catch (error) { response.destroy(); report.errors.push(safeFailure(error)); }
      });
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    report.stage = 'run-probes';
    if (extendedMode) await extended();
    else if (process.argv.includes('--features')) await features();
    else {
    for (let i = 0; i < 2; i++) {
      const item = active = { name: 'direct-short-' + i, startedAt: Date.now() }; report.scenarios.push(item);
      const metrics = await sendUpstream({ model: report.model, max_tokens: 128, stream: true,
        messages: [{ role: 'user', content: '这是 Relay 的合成连接测试，请只回复：你好。' }] }, '/v1/messages', { 'anthropic-version': '2023-06-01' }, null, item);
      item.ok = metrics.status === 200; item.firstTextMs = metrics.firstTextMs; item.totalMs = metrics.totalMs; save();
      console.log(JSON.stringify({ name: item.name, ok: item.ok, firstTextMs: item.firstTextMs, totalMs: item.totalMs }));
    }
    await runTurn('sdk-cold', '这是 Relay 的合成测试，请只回复：你好。');
    await runTurn('sdk-warm', '这是第二轮合成测试，请只回复：续接正常。');
    const replay = active = { name: 'direct-sdk-body-replay', startedAt: Date.now() }; report.scenarios.push(replay);
    const metrics = await sendUpstream(lastBody, '/v1/messages', { 'anthropic-version': '2023-06-01' }, null, replay);
    replay.ok = metrics.status === 200; replay.firstTextMs = metrics.firstTextMs; replay.totalMs = metrics.totalMs;
    await runTurn('sdk-resume', '请用一句话说明前一轮要求你回复什么，禁止使用工具。', { fresh: true, extra: { sessionId } });
    }
    report.ok = report.scenarios.every(item => item.ok) && !report.errors.length;
  } catch (error) { report.ok = false; report.errors.push(safeFailure(error)); }
  finally {
    if (child) await child.kill();
    for (const connection of connections) connection.destroy(); pool.destroy();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    credential = ''; save();
    console.log(JSON.stringify({ ok: report.ok, scenarios: report.scenarios.length, report: 'live-' + suffix + '.json', errors: report.errors }));
    app.exit(report.ok ? 0 : 1);
  }
})();
