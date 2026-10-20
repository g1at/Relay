'use strict';

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process');
const marker = process.argv.indexOf('--argument-fixture');
if (marker >= 0) {
  process.stdout.write(JSON.stringify(process.argv.slice(marker + 1)));
} else {
  const test = require('node:test'), assert = require('node:assert/strict');
  const { spawnManagedSdkProcess } = require('../src/main/sdk/sdk-process-tree');
  const { createHostStdioTransport } = require('../src/main/sdk/host-stdio-transport');
  const windows = { skip: process.platform !== 'win32', timeout: 15000 };

  async function run(command, args, managed, options = {}) {
    const child = (managed ? spawnManagedSdkProcess : cp.spawn)(command, args,
      { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    const stdout = [], stderr = [];
    const timer = setTimeout(() => child.kill(), 10000);
    const result = await new Promise((resolve, reject) => {
      child.stdout.on('data', value => stdout.push(value));
      child.stderr.on('data', value => stderr.push(value));
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString() }));
      child.stdin.end();
    }).finally(() => clearTimeout(timer));
    if (managed) {
      const receipt = await child.relayProcessTree.confirmStopped({ timeoutMs: 2000 });
      assert.equal(receipt.stopConfirmed, true);
      assert.equal(receipt.activeProcesses, 0);
      assert.equal(receipt.pendingExits, 0);
      child.relayProcessTree.closeConfirmed();
    }
    return result;
  }

  test('managed Windows argv matches Node for empty, whitespace, quotes and trailing slashes', windows, async () => {
    const args = ['', 'plain', '含中文', 'with spaces', 'with\ttab', '"nested quotes"',
      'before\\"after', 'before\\\\"after', 'C:\\folder\\', 'C:\\space folder\\', '\\\\', 'last\\\\'];
    const plain = await run(process.execPath, [__filename, '--argument-fixture', ...args], false);
    const managed = await run(process.execPath, [__filename, '--argument-fixture', ...args], true);
    assert.equal(plain.code, 0, plain.stderr);
    assert.deepEqual(JSON.parse(plain.stdout), args);
    assert.deepEqual(managed, plain);
  });

  test('explicit cmd /c preserves split arguments and a single command string', windows, async () => {
    for (const args of [['/d', '/c', 'echo', 'RELAY_CMD_ARGUMENTS'],
      ['/d', '/c', 'echo RELAY_CMD_ARGUMENTS']]) {
      const plain = await run('cmd.exe', args, false);
      const managed = await run('cmd.exe', args, true);
      assert.equal(plain.code, 0, plain.stderr);
      assert.equal(plain.stdout.trim(), 'RELAY_CMD_ARGUMENTS');
      assert.deepEqual(managed, plain);
    }
  });

  test('explicit cmd /c batch keeps its own directory and npm-shaped options', windows, async t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cmd-args-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const bin = path.join(cwd, 'fixture-bin'); fs.mkdirSync(bin);
    const fixture = path.join(bin, 'arguments.cjs');
    fs.writeFileSync(fixture, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    fs.writeFileSync(path.join(bin, 'relay-npx.cmd'),
      '@echo off\r\n"' + process.execPath + '" "%~dp0arguments.cjs" %*\r\n');
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = bin + path.delimiter + (env[pathKey] || '');
    const expected = ['-y', '--registry=https://example.invalid/registry/', '@fixture/server@latest'];
    const args = ['/d', '/c', 'relay-npx', ...expected];
    const plain = await run('cmd.exe', args, false, { cwd, env });
    const managed = await run('cmd.exe', args, true, { cwd, env });
    assert.equal(plain.code, 0, plain.stderr);
    assert.deepEqual(JSON.parse(plain.stdout), expected);
    assert.deepEqual(managed, plain);
  });

  test('host transport supports both npx.cmd and explicit cmd /c npx without network', windows, async () => {
    const npx = path.join(path.dirname(process.execPath), 'npx.cmd');
    assert.equal(fs.existsSync(npx), true, 'native Node test runtime must include its npx.cmd');
    const plain = await run('cmd.exe', ['/d', '/c', 'npx', '--version'], false);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout.trim(), /^\d+\.\d+\.\d+$/);
    for (const config of [{ command: 'cmd', args: ['/c', 'npx', '--version'] },
      { command: npx, args: ['--version'] }]) {
      const transport = createHostStdioTransport({ ...config, env: process.env, stderr: 'pipe' });
      const stdout = [], stderr = [];
      transport.stderr.on('data', value => stderr.push(value));
      // --version is intentionally a process-launch probe rather than MCP JSON.
      transport.onerror = () => {};
      const closed = new Promise(resolve => { transport.onclose = resolve; });
      const start = transport.start();
      transport._process.stdout.on('data', value => stdout.push(value));
      await start;
      await closed;
      const receipt = await transport.close();
      assert.equal(receipt.stopConfirmed, true);
      assert.equal(receipt.activeProcesses, 0);
      assert.equal(receipt.pendingExits, 0);
      assert.equal(Buffer.concat(stderr).toString(), '');
      assert.equal(Buffer.concat(stdout).toString(), plain.stdout);
    }
  });
}
