'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentEnvironment, toWslPath, mapMcpServers, runtimePath } = require('../src/main/sdk/agent-environment');
const { getHostMcpLoopbackOwner: loopbackOwner } = require('../src/main/sdk/host-mcp-loopback');
const { bundledClaudeVersion } = require('../src/main/sdk/sdk-runtime-version');
const hostBridge = config => loopbackOwner(config)?.instance || config.instance;
function fixture(t, overrides = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wsl-fixture-'));
  t.after(() => fs.rmSync(homeDir, { force: true, recursive: true }));
  const configDir = path.join(homeDir, '.claude'); fs.mkdirSync(configDir);
  const linuxExecutable = path.join(homeDir, 'claude'); fs.writeFileSync(linuxExecutable, 'fixture');
  const calls = [], spawned = [], owners = new Set();
  t.after(() => Promise.allSettled([...owners].map(item => item.close())));
  const service = createAgentEnvironment({ platform: 'win32', homeDir, configDir, linuxExecutable,
    env: { SystemRoot: 'C:\\Windows' }, getEnvironment: () => 'wsl',
    runFile: async (file, args) => { calls.push({ file, args }); return args.includes('sh') ? 'Relay-Test\nx86_64' : args.includes('uname') ? 'x86_64' : args.includes('--version') ? `${bundledClaudeVersion()} (Claude Code)` : ''; },
    spawn: (file, args, options) => { const child = { pid: 123, file, args, options }; spawned.push(child); return child; }, ...overrides });
  for (const method of ['prepareOptions', 'prepareMcpServers']) {
    const original = service[method].bind(service);
    service[method] = async (...args) => { const result = await original(...args);
      for (const config of Object.values(method === 'prepareOptions' ? result.mcpServers || {} : result)) { const item = loopbackOwner(config); if (item) owners.add(item); }
      return result;
    };
  }
  return { service, calls, spawned, configDir };
}
test('WSL path mapping handles spaces and rejects UNC/relative paths without shell parsing', () => {
  assert.equal(toWslPath('D:\\a & b\\工作'), '/mnt/d/a & b/工作');
  for (const value of ['\\\\server\\share', 'relative', 'C:relative', 'x\0']) assert.throws(() => toWslPath(value));
});

test('WSL maps native Agent resource prompts and isolated SDK memory without mutating the host snapshot', async t => {
  const f = fixture(t);
  const input = { cwd: 'D:\\Tasks', additionalDirectories: ['D:\\Agent Resource'], settings: { autoMemoryDirectory: 'C:\\Memory\\native', permissions: { additionalDirectories: ['D:\\Agent Resource'] } },
    agents: { fixture: { model: 'inherit', prompt: 'Read D:\\Agent Resource and write to D:\\Tasks', criticalSystemReminder_EXPERIMENTAL: 'Use D:\\Agent Resource' } },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Working in D:\\Tasks' } };
  const before = JSON.stringify(input);
  const prepared = await f.service.prepareOptions(input);
  assert.equal(prepared.settings.autoMemoryDirectory, '/mnt/c/Memory/native');
  assert.equal(prepared.agents.fixture.prompt, 'Read /mnt/d/Agent Resource and write to /mnt/d/Tasks');
  assert.equal(prepared.agents.fixture.criticalSystemReminder_EXPERIMENTAL, 'Use /mnt/d/Agent Resource');
  assert.equal(prepared.systemPrompt.append, 'Working in /mnt/d/Tasks');
  assert.equal(JSON.stringify(input), before);
});

test('WSL settings diagnostic runs inside Linux with encoded path data and only exposes probe summaries', async t => {
  let launch;
  const f = fixture(t, { diagnosticScript: 'D:\\Relay\\sdk-settings-probe.cjs', sdkModulePath: 'D:\\Relay\\sdk.mjs',
    runFile: async (file, args) => { launch = { file, args }; return JSON.stringify({ ok: true, hooksDisabled: true, sources: [{ source: 'user', file: 'settings.json' }] }); } });
  const result = await f.service.inspectSettings({ cwd: 'D:\\Task & name', settingSources: ['user', 'project'] });
  assert.equal(result.ok, true);
  assert.deepEqual(launch.args.slice(0, 5), ['--cd', '/mnt/d/Task & name', '--exec', 'node', '/mnt/d/Relay/sdk-settings-probe.cjs']);
  const payload = JSON.parse(Buffer.from(launch.args[5], 'base64').toString('utf8'));
  assert.equal(payload.cwd, '/mnt/d/Task & name');
  assert.equal(payload.sdkPath, '/mnt/d/Relay/sdk.mjs');
  assert.equal(payload.configDir, toWslPath(f.configDir));
  assert.deepEqual(payload.settingSources, ['user', 'project']);
});

test('default WSL runtime and diagnostic paths remain rooted at the application after source relocation', async t => {
  const root = path.resolve(__dirname, '..');
  assert.equal(runtimePath(), path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'));
  let launch;
  const f = fixture(t, { runFile: async (_file, args) => { launch = args; return JSON.stringify({ ok: true }); } });
  assert.equal((await f.service.inspectSettings({ cwd: 'D:\\Project outside Relay', settingSources: ['user'] })).ok, true);
  const script = require.resolve('../src/main/sdk/sdk-settings-probe.cjs');
  assert.equal(launch[4], toWslPath(script));
  assert.equal(fs.existsSync(script), true);
  const payload = JSON.parse(Buffer.from(launch[5], 'base64').toString('utf8'));
  assert.equal(payload.sdkPath, toWslPath(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')));
  assert.equal(payload.cwd, '/mnt/d/Project outside Relay');
});

test('a missing WSL diagnostic interpreter cannot cause a Windows config fallback', async t => {
  const f = fixture(t, { runFile: async () => { throw Error('node missing at /secret/user/path'); } });
  const result = await f.service.inspectSettings({ cwd: 'D:\\Work' });
  assert.equal(result.code, 'WSL_DIAGNOSTICS_UNAVAILABLE');
  assert.match(result.error, /Node.js/);
  assert.equal(JSON.stringify(result).includes('/secret'), false);
});
test('WSL config diagnostics can inspect the active task distro even after the default changes', async t => {
  let launch;
  const f = fixture(t, { runFile: async (_file, args) => { launch = args; return JSON.stringify({ ok: true }); } });
  assert.equal((await f.service.inspectSettings({ cwd: 'D:\\Task', wslDistribution: 'Pinned-Task' })).ok, true);
  assert.deepEqual(launch.slice(0, 5), ['--distribution', 'Pinned-Task', '--cd', '/mnt/d/Task', '--exec']);
  launch = null;
  assert.equal((await f.service.inspectSettings({ cwd: 'D:\\Task', wslDistribution: '../Other' })).ok, false);
  assert.equal(launch, null);
});
test('native tasks bypass every WSL probe even when global setting was changed after snapshot', async t => {
  const f = fixture(t), input = { env: { RELAY_AGENT_ENVIRONMENT: 'native' } };
  assert.equal(await f.service.prepareOptions(input), input); assert.equal(f.calls.length, 0);
});
test('preflight separates missing distribution, incompatible architecture and wrong runtime version', async t => {
  const unavailable = fixture(t, { runFile: async () => { throw Error('not installed'); } });
  assert.equal((await unavailable.service.probe()).terminalAvailable, false);
  const arm = fixture(t, { runFile: async () => 'Relay-Test\naarch64' });
  assert.equal((await arm.service.probe()).code, 'WSL_ARCH_UNSUPPORTED');
  assert.equal((await arm.service.probe()).terminalAvailable, true);
  const old = fixture(t, { runFile: async (_file, args) => args.includes('sh') ? 'Relay-Test\nx86_64' : '2.0.0' });
  assert.equal((await old.service.probe()).code, 'WSL_RUNTIME_VERSION');
});
test('WSL runtime version follows the installed SDK and compares complete versions', async t => {
  const current = fixture(t);
  const ready = await current.service.probe();
  assert.equal(ready.available, true);
  assert.equal(ready.version, bundledClaudeVersion());
  const prefixed = fixture(t, { expectedVersion: '2.1.28',
    runFile: async (_file, args) => args.includes('sh') ? 'Relay-Test\nx86_64' : '2.1.283 (Claude Code)' });
  assert.equal((await prefixed.service.probe()).code, 'WSL_RUNTIME_VERSION');
  const injected = fixture(t, { expectedVersion: '9.8.7',
    runFile: async (_file, args) => args.includes('sh') ? 'Relay-Test\nx86_64' : '9.8.7 (Claude Code)' });
  assert.equal((await injected.service.probe()).version, '9.8.7');
  const unknown = fixture(t, { expectedVersion: '' });
  assert.equal((await unknown.service.probe()).code, 'WSL_RUNTIME_VERSION_METADATA');
});
test('MCP HTTP/in-process tools are retained; local commands use Windows host bridges without path translation', () => {
  const sdk = { type: 'sdk', instance: {} };
  const result = mapMcpServers({ internal: sdk, web: { type: 'http', url: 'https://example.invalid' }, local: { command: 'node', args: ['D:\\MCP\\server.js'], env: { ROOT: 'D:\\Data' } } });
  assert.equal(result.internal, sdk); assert.equal(result.web.url, 'https://example.invalid');
  assert.equal(result.local.instance.config.args[0], 'D:\\MCP\\server.js');
  assert.equal(result.local.instance.config.env.ROOT, 'D:\\Data');
  assert.equal(mapMcpServers({ required: { command: 'cmd', args: ['/c', 'npx', 'server'] } }).required.type, 'sdk');
});
test('Windows-only shared hooks are preflight errors, never silently omitted', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.configDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'powershell.exe -File D:\\hook.ps1' }] }] } }));
  const result = await f.service.probe(); assert.equal(result.available, false); assert.equal(result.code, 'WSL_HOOK_INCOMPATIBLE');
});
test('WSL launches verified runtime and bridges provider credentials through environment only', async t => {
  const f = fixture(t); let onSpawn;
  const input = { cwd: 'D:\\Task & name', additionalDirectories: ['C:\\Users\\test\\memory'], pathToClaudeCodeExecutable: 'D:\\relay\\claude.exe',
    env: { RELAY_AGENT_ENVIRONMENT: 'wsl', ANTHROPIC_API_KEY: 'synthetic-secret', ANTHROPIC_BASE_URL: 'https://example.invalid', NODE_EXTRA_CA_CERTS: 'C:\\cert.pem', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' },
    mcpServers: { test: { command: 'node', args: ['D:\\server.js'] } } };
  const prepared = await f.service.prepareOptions(input, { onSpawn: child => { onSpawn = child; } });
  assert.equal(prepared.cwd, '/mnt/d/Task & name');
  assert.deepEqual(prepared.additionalDirectories, ['/mnt/c/Users/test/memory']);
  const child = prepared.spawnClaudeCodeProcess({ args: ['--model', 'synthetic-model'], env: prepared.env });
  assert.equal(child, onSpawn);
  assert.equal(JSON.stringify(child.args).includes('synthetic-secret'), false);
  assert.equal(child.options.env.ANTHROPIC_API_KEY, 'synthetic-secret');
  assert.match(child.options.env.WSLENV, /ANTHROPIC_API_KEY/);
  assert.equal(child.options.env.NODE_EXTRA_CA_CERTS, '/mnt/c/cert.pem');
  assert.deepEqual(child.args.slice(0, 5), ['--distribution', 'Relay-Test', '--cd', '/mnt/d/Task & name', '--exec']);
  assert.equal(child.options.shell, false);
  assert.equal(input.cwd, 'D:\\Task & name');
});

test('WSL resources retain the actual distro and cwd without repeating preflight for every launch', async t => {
  const f = fixture(t);
  let preparedContext, spawnContext;
  const first = await f.service.prepareOptions({ cwd: 'D:\\Task', env: { RELAY_AGENT_ENVIRONMENT: 'wsl' } }, {
    onPrepared: context => { preparedContext = context; }, onSpawn: (_child, context) => { spawnContext = context; },
  });
  assert.deepEqual(preparedContext, { agentEnvironment: 'wsl', wslDistribution: 'Relay-Test', cwd: '/mnt/d/Task' });
  assert.equal(Object.isFrozen(preparedContext), true);
  const callCount = f.calls.length;
  const second = await f.service.prepareOptions({ cwd: 'D:\\Another task' });
  assert.equal(f.calls.length, callCount);
  first.spawnClaudeCodeProcess({ args: [], env: first.env });
  second.spawnClaudeCodeProcess({ args: [], env: second.env });
  assert.deepEqual(spawnContext, preparedContext);
  for (const child of f.spawned) assert.deepEqual(child.args.slice(0, 2), ['--distribution', 'Relay-Test']);
  assert.deepEqual(f.calls.find(call => call.args.includes('--version')).args.slice(0, 2), ['--distribution', 'Relay-Test']);
  assert.equal(first.wslDistribution, undefined, 'metadata must not become an undocumented SDK option');
});

test('an old WSL launch stays pinned if a refreshed probe sees a new Windows default distribution', async t => {
  let current = 'First-Distro';
  const f = fixture(t, { runFile: async (_file, args) => args.includes('sh') ? `${current}\nx86_64` : bundledClaudeVersion() });
  const first = await f.service.prepareOptions({ cwd: 'D:\\Task' });
  current = 'Second-Distro';
  await f.service.probe({ refresh: true, runtimeOnly: true });
  const second = await f.service.prepareOptions({ cwd: 'D:\\Task' });
  assert.equal(first.spawnClaudeCodeProcess({ args: [], env: first.env }).args[1], 'First-Distro');
  assert.equal(second.spawnClaudeCodeProcess({ args: [], env: second.env }).args[1], 'Second-Distro');
});

test('invalid distribution metadata cannot launch an ambiguous or different WSL resource namespace', async t => {
  const f = fixture(t, { runFile: async () => '../Other\nx86_64' });
  assert.equal((await f.service.probe()).code, 'WSL_DISTRIBUTION_UNAVAILABLE');
  await assert.rejects(f.service.prepareOptions({ cwd: 'D:\\Task' }), /发行版/);
  assert.equal(f.spawned.length, 0);
});
test('canceled task cannot spawn after asynchronous environment preflight', async t => {
  const f = fixture(t), abortController = new AbortController(); abortController.abort();
  await assert.rejects(f.service.prepareOptions({ env: { RELAY_AGENT_ENVIRONMENT: 'wsl' }, abortController }), /取消/);
  assert.equal(f.spawned.length, 0);
});

test('WSL cannot resurrect discarded host authentication via its process environment or WSLENV', async t => {
  const f = fixture(t, { env: { SystemRoot: 'C:\\Windows', ANTHROPIC_API_KEY: 'foreign-secret', ANTHROPIC_AUTH_TOKEN: 'foreign-token', CLAUDE_CODE_USE_BEDROCK: '1', WSLENV: 'ANTHROPIC_API_KEY:ANTHROPIC_AUTH_TOKEN:CLAUDE_CODE_USE_BEDROCK:PATH/p' } });
  const prepared = await f.service.prepareOptions({ cwd: 'D:\\Tasks', env: { ANTHROPIC_AUTH_TOKEN: 'relay-token', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' } });
  const child = prepared.spawnClaudeCodeProcess({ args: [], env: prepared.env });
  assert.equal(child.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.options.env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(child.options.env.ANTHROPIC_AUTH_TOKEN, 'relay-token');
  assert.equal(child.options.env.WSLENV.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(child.options.env.WSLENV.split(':').includes('PATH'), false);
  assert.equal(JSON.stringify(child).includes('foreign-secret'), false);
});

test('WSL preserves explicit isolated config and bridges debug, settings and plugin resource paths', async t => {
  const f = fixture(t);
  const isolated = path.join(f.configDir, 'isolated'); fs.mkdirSync(isolated);
  const prepared = await f.service.prepareOptions({ cwd: 'D:\\Tasks', settings: 'D:\\Settings\\project.json', debugFile: 'D:\\Logs\\debug.log',
    plugins: [{ type: 'local', path: 'D:\\Plugins\\tool' }], env: { CLAUDE_CONFIG_DIR: isolated } });
  assert.equal(prepared.env.CLAUDE_CONFIG_DIR, toWslPath(isolated));
  assert.equal(prepared.settings, '/mnt/d/Settings/project.json');
  assert.equal(prepared.debugFile, '/mnt/d/Logs/debug.log');
  assert.equal(prepared.plugins[0].path, '/mnt/d/Plugins/tool');
});

test('live MCP reload uses host bridges in both native and WSL environments', async t => {
  const f = fixture(t), servers = { local: { command: 'node', args: ['D:\\Server\\main.js'] } };
  const native = await f.service.prepareMcpServers(servers, { environment: 'native' });
  assert.equal(native.local.type, 'http');
  t.after(() => loopbackOwner(native.local).close());
  assert.equal(loopbackOwner(native.local).instance.config, servers.local);
  assert.equal(hostBridge((await f.service.prepareMcpServers(servers, { environment: 'wsl' })).local).config.args[0], 'D:\\Server\\main.js');
  assert.equal((await f.service.prepareMcpServers({ local: { command: 'cmd.exe' } }, { environment: 'wsl' })).local.type, 'stdio');
});

test('an isolated query and later MCP reload stay bound to their resource directory despite incompatible global resources', async t => {
  const f = fixture(t), isolated = path.join(f.configDir, 'isolated'); fs.mkdirSync(isolated);
  // A failed settings-page capability check must not poison runtime-only checks.
  fs.writeFileSync(path.join(f.configDir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cmd.exe /c echo fixture' }] }] } }));
  assert.equal((await f.service.probe()).code, 'WSL_HOOK_INCOMPATIBLE');
  const prepared = await f.service.prepareOptions({ cwd: 'D:\\Tasks', env: { CLAUDE_CONFIG_DIR: isolated, RELAY_AGENT_ENVIRONMENT: 'wsl' } });
  assert.equal(prepared.env.CLAUDE_CONFIG_DIR, toWslPath(isolated));
  assert.deepEqual(await f.service.prepareMcpServers({}, { environment: 'wsl', resourceDir: isolated }), {});
  await assert.rejects(f.service.prepareMcpServers({}, { environment: 'wsl' }), /Windows/);
  // A newly invalid hook in the pinned directory still fails closed, even when
  // an unrelated directory is valid. Pinning does not skip resource validation.
  fs.writeFileSync(path.join(isolated, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'powershell.exe -File fixture.ps1' }] }] } }));
  await assert.rejects(f.service.prepareMcpServers({}, { environment: 'wsl', resourceDir: isolated }), /Windows/);
});

test('Windows-only or missing MCP dependencies cannot disable WSL and bridge instances belong to one Query', async t => {
  const f = fixture(t, { getMcpServers: () => ({ windows: { command: 'C:\\Tools\\server.exe' }, absent: { command: 'not-installed-anywhere' } }) });
  assert.equal((await f.service.probe()).available, true);
  assert.equal(f.calls.some(call => call.args.includes('/bin/sh')), false);
  const input = { cwd: 'D:\\Task', mcpServers: { windows: { command: 'cmd.exe', args: ['/c', 'fixture'] } }, env: { RELAY_AGENT_ENVIRONMENT: 'wsl', PATH: 'C:\\Windows' } };
  const first = await f.service.prepareOptions(input), second = await f.service.prepareOptions(input);
  const again = await f.service.prepareMcpServers(input.mcpServers, { environment: 'wsl', prepared: first });
  assert.equal(hostBridge(again.windows), hostBridge(first.mcpServers.windows));
  assert.notEqual(hostBridge(second.mcpServers.windows), hostBridge(first.mcpServers.windows));
  const changed = await f.service.prepareMcpServers({ windows: { command: 'node.exe' } }, { environment: 'wsl', prepared: first });
  assert.notEqual(hostBridge(changed.windows), hostBridge(first.mcpServers.windows));
  assert.equal(hostBridge(changed.windows).options.env.PATH, 'C:\\Windows');
});


test('WSL keeps project cwd while translating scratch, SDK runtime storage and escaped Agent instructions', async t => {
  const f = fixture(t), sdk = require('../src/main/sdk/claude-sdk');
  const cwd = 'D:\\Synthetic Project', scratchDir = 'C:\\Synthetic Relay\\conversation-scratch\\session', outputDir = cwd + '\\outputs';
  const input = sdk._buildOptions({ cwd, validWorkingDir: cwd, scratchDir, outputDir, permissionMode: 'default',
    runtimeEnv: { RELAY_AGENT_ENVIRONMENT: 'wsl', CLAUDE_CODE_TMPDIR: 'C:\\Synthetic Relay\\sdk-runtime\\tmp',
      CLAUDE_CODE_DEBUG_LOGS_DIR: 'C:\\Synthetic Relay\\sdk-runtime\\debug', XDG_CACHE_HOME: 'C:\\Synthetic Relay\\sdk-runtime\\cache' },
    nativeAgent: { agent: 'writer', agents: { writer: { prompt: 'Original instruction' } } } });
  const before = JSON.stringify(input);
  const prepared = await f.service.prepareOptions(input);
  assert.equal(prepared.cwd, '/mnt/d/Synthetic Project');
  assert.equal(prepared.env.RELAY_OUTPUT_DIR, '/mnt/d/Synthetic Project/outputs');
  assert.ok(prepared.systemPrompt.append.includes(JSON.stringify('/mnt/d/Synthetic Project/outputs')));
  assert.ok(prepared.agents.writer.prompt.includes(JSON.stringify('/mnt/d/Synthetic Project/outputs')));
  const scratch = '/mnt/c/Synthetic Relay/conversation-scratch/session';
  for (const key of ['TEMP', 'TMP', 'TMPDIR', 'RELAY_SCRATCH_DIR']) assert.equal(prepared.env[key], scratch);
  assert.equal(prepared.env.CLAUDE_CODE_TMPDIR, '/mnt/c/Synthetic Relay/sdk-runtime/tmp');
  assert.equal(prepared.env.CLAUDE_CODE_DEBUG_LOGS_DIR, '/mnt/c/Synthetic Relay/sdk-runtime/debug');
  assert.equal(prepared.env.XDG_CACHE_HOME, '/mnt/c/Synthetic Relay/sdk-runtime/cache');
  assert.equal(prepared.env.CLAUDE_CONFIG_DIR, toWslPath(f.configDir), 'preserve legacy resources');
  assert.ok(prepared.additionalDirectories.includes(scratch));
  assert.ok(prepared.systemPrompt.append.includes(JSON.stringify(scratch)));
  assert.ok(prepared.agents.writer.prompt.includes(JSON.stringify(scratch)));
  const child = prepared.spawnClaudeCodeProcess({ args: [], env: prepared.env });
  assert.deepEqual(child.args.slice(0, 4), ['--distribution', 'Relay-Test', '--cd', '/mnt/d/Synthetic Project']);
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
    assert.equal(child.options.env[key], scratch); assert.ok(child.options.env.WSLENV.split(':').includes(key));
  }
  assert.equal(child.options.env.RELAY_OUTPUT_DIR, '/mnt/d/Synthetic Project/outputs');
  assert.ok(child.options.env.WSLENV.split(':').includes('RELAY_OUTPUT_DIR'));
  assert.equal(JSON.stringify(input), before);
});


test('WSL translates file policy in custom system prompt blocks without moving the SDK cache boundary', async t => {
  const f = fixture(t), sdk = require('../src/main/sdk/claude-sdk'), boundary = '__SYNTHETIC_DYNAMIC_BOUNDARY__';
  const input = sdk._buildOptions({ cwd: 'D:\\Task', scratchDir: 'C:\\Relay\\Scratch', outputDir: 'D:\\Task\\outputs',
    customSystemPrompt: { static: ['Fixed instruction'], dynamic: ['Dynamic instruction'] } },
    { SYSTEM_PROMPT_DYNAMIC_BOUNDARY: boundary });
  const before = JSON.stringify(input.systemPrompt);
  const prepared = await f.service.prepareOptions(input);
  assert.equal(prepared.systemPrompt.type, 'custom');
  assert.deepEqual(prepared.systemPrompt.prompt.slice(0, 3), ['Fixed instruction', boundary, 'Dynamic instruction']);
  assert.match(prepared.systemPrompt.prompt[3], /\/mnt\/d\/Task\/outputs/);
  assert.match(prepared.systemPrompt.prompt[3], /\/mnt\/c\/Relay\/Scratch/);
  assert.equal(JSON.stringify(input.systemPrompt), before);
});

test('native local MCPs share the existing cached host lifecycle without a WSL probe', async t => {
  const f = fixture(t, { getEnvironment: () => 'native' });
  const local = { command: 'fixture-only', args: ['server'], env: { SAMPLE: 'fixture' } };
  const remote = { type: 'http', url: 'https://example.invalid' };
  const sdk = { type: 'sdk', instance: {} };
  const input = { cwd: 'D:\\Task', env: { RELAY_AGENT_ENVIRONMENT: 'native' }, mcpServers: { local, remote, sdk } };
  const before = JSON.stringify(input);
  const prepared = await f.service.prepareOptions(input);
  assert.equal(f.calls.length, 0);
  assert.equal(prepared.mcpServers.local.type, 'http');
  t.after(() => loopbackOwner(prepared.mcpServers.local).close());
  assert.equal(loopbackOwner(prepared.mcpServers.local).instance.config, local);
  assert.equal(prepared.mcpServers.remote, remote);
  assert.equal(prepared.mcpServers.sdk, sdk);
  assert.equal(JSON.stringify(input), before);
  const same = await f.service.prepareMcpServers(input.mcpServers, { environment: 'native', prepared });
  assert.equal(same.local, prepared.mcpServers.local);
  const changed = await f.service.prepareMcpServers({ local: { ...local, args: ['other'] }, remote }, { environment: 'native', prepared });
  t.after(() => loopbackOwner(changed.local).close());
  assert.notEqual(loopbackOwner(changed.local).instance, loopbackOwner(same.local).instance);
  assert.equal(changed.remote, remote);
  assert.equal(f.calls.length, 0);
  await loopbackOwner(same.local).close(); await loopbackOwner(changed.local).close();
});

test('native sessions created before local MCP attachment retain a reusable bridge context', async t => {
  const f = fixture(t, { getEnvironment: () => 'native' });
  const input = { model: 'sonnet', cwd: 'D:\\Task', env: { RELAY_AGENT_ENVIRONMENT: 'native' } };
  const prepared = await f.service.prepareOptions(input);
  assert.equal(prepared, input);
  const local = { command: 'fixture-only' };
  const first = await f.service.prepareMcpServers({ local }, { environment: 'native', prepared });
  // The projection is model-independent and equivalent, including later model switches.
  prepared.model = 'moonshot/kimi-k3[1m]';
  const second = await f.service.prepareMcpServers({ local }, { environment: 'native', prepared });
  assert.equal(first.local, second.local);
  t.after(() => loopbackOwner(first.local).close());
  assert.equal(loopbackOwner(first.local).instance.options.cwd, input.cwd);
  assert.equal(f.calls.length, 0);
  await loopbackOwner(first.local).close();
});


test('WSL maps inline SDK path flags and legacy split flags without parsing other option values', async t => {
  const f = fixture(t);
  const input = { cwd: 'D:\\Task & name', pathToClaudeCodeExecutable: 'D:\\Relay\\claude.exe' };
  const prepared = await f.service.prepareOptions(input);
  const flags = ['--add-dir', '--plugin-dir', '--plugin-dir-no-mcp', '--debug-file', '--settings', '--resume', '--session-debug-file'];
  const sourceArgs = [input.pathToClaudeCodeExecutable];
  const mapped = [];
  for (const flag of flags) {
    const value = 'D:\\Paths = &\\中文\\' + flag.slice(2);
    sourceArgs.push(flag + '=' + value, flag, value);
    mapped.push(flag + '=' + toWslPath(value), flag, toWslPath(value));
  }
  const inlineSettings = JSON.stringify({ permissions: { additionalDirectories: ['C:\\Windows-only resource'] } });
  const passthrough = ['--settings=' + inlineSettings, '--settings', inlineSettings,
    '--resume=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--debug-file=/tmp/already-linux',
    '--model=D:\\literal-model', '--append-system-prompt=D:\\literal-prompt',
    '--unknown-path=D:\\leave-untouched', '--add-dir='];
  sourceArgs.push(...passthrough); mapped.push(...passthrough);
  const before = [...sourceArgs];
  const child = prepared.spawnClaudeCodeProcess({ args: sourceArgs, env: prepared.env });
  assert.deepEqual(child.args.slice(6), mapped);
  assert.deepEqual(sourceArgs, before, 'never mutate the SDK argument snapshot');
  assert.equal(child.options.shell, false);
});
