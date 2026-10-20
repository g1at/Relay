'use strict';

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process');
const fixtureIndex = process.argv.indexOf('--fixture-stage');
if (fixtureIndex >= 0) {
  const stage = Number(process.argv[fixtureIndex + 1]);
  const nonce = process.argv[fixtureIndex + 2];
  const cwd = process.cwd();
  fs.writeFileSync(path.join(cwd, `stage-${stage}.json`), JSON.stringify({ pid: process.pid, ppid: process.ppid, nonce, cwd }));
  if (stage < 2) {
    const child = cp.spawn(process.execPath, [__filename, '--fixture-stage', String(stage + 1), nonce],
      { cwd, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  process.stdin.resume();
  setInterval(() => { if (stage === 0 && fs.existsSync(path.join(cwd, 'exit-root'))) process.exit(0); }, 20);
} else {
  const test = require('node:test'), assert = require('node:assert/strict');
  const { randomUUID } = require('node:crypto');
  const { HostStdioMcpServer, createRuntimeMcpMapper } = require('../src/main/sdk/host-stdio-mcp');
  const { createRuntimeClosure } = require('../src/main/sdk/sdk-runtime-closure');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  async function until(condition, label) {
    const end = Date.now() + 10000;
    while (!condition()) { assert.ok(Date.now() < end, label); await delay(20); }
  }
  async function launch(t, label, { shim = false } = {}) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-' + label + '-'));
    const nonce = randomUUID();
    let command = process.execPath, args = [__filename, '--fixture-stage', '0', nonce];
    if (shim) {
      const bin = path.join(cwd, '含空格 scripts'); fs.mkdirSync(bin);
      command = path.join(bin, 'fixture launcher.cmd');
      fs.writeFileSync(command, '@echo off\r\n"' + process.execPath + '" "' + __filename + '" --fixture-stage 0 %1\r\n');
      args = [nonce];
    }
    const server = new HostStdioMcpServer(label, { command, args, cwd, env: { ...process.env } });
    t.after(async () => { await server.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
    await server.connect({ start: async () => {}, send: async () => {} });
    await server.startChild();
    const transport = server.childTransport;
    await until(() => [0, 1, 2].every(stage => fs.existsSync(path.join(cwd, `stage-${stage}.json`))), 'all MCP generations must start');
    const members = [0, 1, 2].map(stage => JSON.parse(fs.readFileSync(path.join(cwd, `stage-${stage}.json`), 'utf8')));
    for (const member of members) { assert.equal(member.nonce, nonce); assert.equal(alive(member.pid), true); }
    assert.ok(transport.relayProcessTree);
    if (!shim) assert.equal(transport.pid, members[0].pid, 'transport pid reports the MCP root, not the Job launcher');
    const mapper = createRuntimeMcpMapper({ local: { type: 'sdk', instance: server } }, value => value);
    const closure = createRuntimeClosure({ getMapper: () => mapper, timeoutMs: 25, onClosed() {} });
    return { cwd, nonce, server, transport, members, closure };
  }
  async function closeAndRemove(fixture) {
    const first = await fixture.closure.finish({ stopConfirmed: true });
    if (!first.stopConfirmed) assert.equal(first.code, 'RUNTIME_RESOURCE_CLEANUP_PENDING');
    await fixture.server.close();
    assert.equal((await fixture.closure.whenClosed()).stopConfirmed, true);
    const snapshot = fixture.transport.relayProcessTree.snapshot();
    assert.equal(snapshot.activeProcesses, 0); assert.equal(snapshot.pendingExits, 0);
    for (const member of fixture.members) assert.equal(alive(member.pid), false, 'all owned MCP descendants must have exited');
    fs.rmSync(fixture.cwd, { recursive: true });
    assert.equal(fs.existsSync(fixture.cwd), false, 'the actual cwd directory is deletable after receipt');
  }
  test('owned MCP stop closes detached grandchildren and leaves a parallel conversation alive', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
    const first = await launch(t, 'first'), other = await launch(t, 'other');
    assert.notEqual(first.transport.relayProcessTree.scopeId, other.transport.relayProcessTree.scopeId);
    await closeAndRemove(first);
    for (const member of other.members) assert.equal(alive(member.pid), true, 'unrelated conversation MCP must stay alive');
    await closeAndRemove(other);
  });
  test('natural MCP root exit cannot confirm cleanup while its detached descendants retain cwd', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const fixture = await launch(t, 'natural');
    fs.writeFileSync(path.join(fixture.cwd, 'exit-root'), 'fixture');
    await until(() => !alive(fixture.members[0].pid), 'MCP root must exit naturally');
    await closeAndRemove(fixture);
  });
  test('Windows MCP cmd shims retain quoting for command paths containing spaces', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const fixture = await launch(t, 'shim', { shim: true });
    await closeAndRemove(fixture);
  });
}
