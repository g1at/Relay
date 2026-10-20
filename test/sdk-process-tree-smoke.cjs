'use strict';

// Windows-only, opt-in acceptance of native Job Object containment.
// node test/sdk-process-tree-smoke.cjs --run
// ELECTRON_RUN_AS_NODE=1 electron test/sdk-process-tree-smoke.cjs --run
// Starts only synthetic Node processes in unique temporary directories. No SDK,
// provider requests, user settings, or existing user processes are accessed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');

const fixtureIndex = process.argv.indexOf('--fixture');
if (fixtureIndex !== -1) {
  const stage = Number(process.argv[fixtureIndex + 1]);
  const nonce = process.argv[fixtureIndex + 2];
  const cwd = process.cwd();
  fs.writeFileSync(path.join(cwd, stage === 3 ? 'churn-' + process.pid + '.json' : 'stage-' + stage + '.json'),
    JSON.stringify({ pid: process.pid, ppid: process.ppid, stage, nonce, cwd }));
  if (stage < 2) {
    const descendant = cp.spawn(process.execPath,
      [__filename, '--fixture', String(stage + 1), nonce],
      { cwd, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
    descendant.unref();
  }
  process.on('SIGTERM', () => {});
  if (stage === 0 && process.env.RELAY_TREE_FIXTURE_CHURN === '1') {
    let launched = 0;
    setInterval(() => {
      if (!fs.existsSync(path.join(cwd, 'start-churn')) || launched >= 16) return;
      launched++;
      try {
        const descendant = cp.spawn(process.execPath, [__filename, '--fixture', '3', nonce],
          { cwd, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
        descendant.on('error', () => {});
        descendant.unref();
      } catch (_) { /* The native stop boundary deliberately refuses new members. */ }
    }, 15);
  }
  if (stage === 0) {
    process.stdin.on('data', value => process.stdout.write('fixture-echo:' + value));
    process.stdout.write('fixture-root-ready:' + nonce + '\n');
  }
  setInterval(() => {
    if (stage === 0 && fs.existsSync(path.join(cwd, 'exit-root'))) process.exit(0);
  }, 30);
} else if (!process.argv.includes('--run')) {
  console.log('Opt-in only: native Windows Node or Electron Node mode, with --run.');
} else {
  void run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

async function run() {
  assert.equal(process.platform, 'win32', 'This smoke validates native Windows Job Objects.');
  assert.notEqual(process.type, 'browser', 'Use ELECTRON_RUN_AS_NODE=1 when invoking Electron.');
  const { spawnManagedSdkProcess } = require('../src/main/sdk/sdk-process-tree');
  const { SdkProcessSupervisor } = require('../src/main/sdk/sdk-process-supervisor');
  const outputArg = process.argv.find(value => value.startsWith('--output-dir='));
  const output = outputArg ? path.resolve(outputArg.slice('--output-dir='.length))
    : path.resolve(__dirname, '../.codex-tmp/sdk-process-tree-smoke-' + (process.versions.electron ? 'electron' : 'node'));
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'isolated-'));
  const report = { ok: false, platform: process.platform, node: process.versions.node,
    electron: process.versions.electron || null, root, scenarios: [], checks: [], errors: [] };
  report.nativeHashes = Object.fromEntries(['win32-x64.node', 'sdk-job-launcher-win32-x64.exe'].map(name =>
    [name, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../src/main/sdk/native', name))).digest('hex')]));
  const fixtures = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false; throw error;
  } };
  async function until(predicate, description, timeoutMs = 10000) {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw Error('Timed out: ' + description);
      await delay(20);
    }
  }
  async function bounded(promise, description, timeoutMs = 10000) {
    let timer;
    try { return await Promise.race([promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + description)), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  function launch(label, { churn = false } = {}) {
    const cwd = path.join(root, label + ' 空格工作目录');
    fs.mkdirSync(cwd);
    const nonce = randomUUID();
    fs.writeFileSync(path.join(cwd, 'preserve.txt'), nonce);
    const lifecycle = [], errors = [];
    const child = spawnManagedSdkProcess(process.execPath,
      [__filename, '--fixture', '0', nonce],
      { cwd, env: { ...process.env, ...(churn ? { RELAY_TREE_FIXTURE_CHURN: '1' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { errors.push({ code: error.code, message: error.message }); });
    const supervisor = new SdkProcessSupervisor({ graceMs: 50, retryMs: 20,
      onLifecycle: event => lifecycle.push(event) });
    supervisor.attach(child);
    supervisor.markSpawnSettled();
    const fixture = { label, cwd, nonce, child, supervisor, lifecycle, errors,
      get stdout() { return stdout; }, get stderr() { return stderr; }, members: [] };
    fixtures.push(fixture);
    return fixture;
  }
  async function ready(fixture) {
    await until(() => [0, 1, 2].every(stage => fs.existsSync(path.join(fixture.cwd, 'stage-' + stage + '.json'))),
      fixture.label + ' three generations ready');
    fixture.members = [0, 1, 2].map(stage => JSON.parse(fs.readFileSync(path.join(fixture.cwd, 'stage-' + stage + '.json'), 'utf8')));
    for (const member of fixture.members) {
      assert.equal(member.nonce, fixture.nonce);
      assert.equal(member.cwd.toLowerCase(), fixture.cwd.toLowerCase());
      assert.equal(alive(member.pid), true, 'owned fixture PID starts alive');
    }
    assert.equal(fixture.members[1].ppid, fixture.members[0].pid);
    assert.equal(fixture.members[2].ppid, fixture.members[1].pid);
    assert.equal(fixture.child.sdkPid, fixture.members[0].pid, 'SDK PID is distinct from the launcher PID');
    assert.notEqual(fixture.child.relayHostPid, fixture.child.sdkPid);
    fixture.child.stdin.write(fixture.nonce + '\n');
    await until(() => fixture.stdout.includes('fixture-echo:' + fixture.nonce), fixture.label + ' stdin/stdout forwarding');
    return fixture;
  }
  function assertSurvivor(fixture) {
    for (const member of fixture.members) assert.equal(alive(member.pid), true,
      'unrelated fixture ' + fixture.label + ' process remains alive: ' + member.stage);
    assert.equal(fs.readFileSync(path.join(fixture.cwd, 'preserve.txt'), 'utf8'), fixture.nonce);
    assert.equal(fixture.supervisor.snapshot().exited, false);
  }
  async function confirmAndRemove(fixture, closed) {
    assert.equal(closed.stopConfirmed, true);
    assert.equal(closed.processTree, true);
    assert.equal(closed.activeProcesses, 0);
    assert.equal(closed.pendingExits, 0);
    await until(() => fixture.members.every(member => !alive(member.pid)), fixture.label + ' all native descendants exited', 3000);
    const record = { label: fixture.label, members: fixture.members, receipt: closed,
      directoryDeleted: false, lifecycle: fixture.lifecycle, errors: fixture.errors };
    report.scenarios.push(record);
    fs.rmSync(fixture.cwd, { recursive: true });
    assert.equal(fs.existsSync(fixture.cwd), false, 'native cwd handles released before deletion');
    record.directoryDeleted = true;
  }
  async function assertReceiptIsolation() {
    const { EventEmitter } = require('node:events');
    for (const kind of ['same-pid-wrong-scope', 'missing-receipt', 'descendants-not-confirmed', 'kernel-exit-pending', 'close-handle-failed']) {
      const child = new EventEmitter();
      Object.assign(child, { pid: 77777, sdkPid: 88888, exitCode: null, signalCode: null,
        kill() { throw Error('A stale PID must never be used to kill another process'); } });
      const scopeId = 'fixture-owned-' + randomUUID();
      const valid = { stopConfirmed: true, processTree: true, scopeId, activeProcesses: 0, pendingExits: 0, sdkPid: child.sdkPid };
      let validNow = false, closedCalls = 0, notified = false;
      child.relayProcessTree = { scopeId, async confirmStopped() {
        if (validNow || kind === 'close-handle-failed') return valid;
        if (kind === 'missing-receipt') return undefined;
        if (kind === 'kernel-exit-pending') return { ...valid, pendingExits: 1 };
        if (kind === 'same-pid-wrong-scope') return { ...valid, scopeId: 'fixture-other-scope' };
        return { ...valid, stopConfirmed: false, activeProcesses: 1, reason: 'descendants-running' };
      }, closeConfirmed() {
        if (!validNow && kind === 'close-handle-failed') throw Object.assign(Error('synthetic handle-close failure'), { code: 'EPERM' });
        closedCalls++;
      } };
      const supervisor = new SdkProcessSupervisor({ graceMs: 0, retryMs: 10, onExit() { notified = true; } });
      supervisor.attach(child); supervisor.markSpawnSettled();
      let resolved = false;
      supervisor.whenExited().then(() => { resolved = true; });
      child.exitCode = 0; child.emit('exit', 0, null);
      await delay(50);
      assert.equal(resolved, false, kind + ' cannot resolve stop confirmation');
      assert.equal(notified, false, kind + ' cannot report onExit');
      assert.equal(closedCalls, 0, kind + ' must retain ownership');
      validNow = true;
      const recovered = await bounded(supervisor.stop(), kind + ' retry recovery', 1000);
      assert.equal(recovered.stopConfirmed, true);
      assert.equal(closedCalls, 1);
      report.checks.push(kind + ': rejected unsafe confirmation and recovered only after matching scoped receipt.');
    }
    const child = new EventEmitter();
    Object.assign(child, { pid: 77778, exitCode: null, signalCode: null, kill() { return true; } });
    let release, closeCalls = 0;
    const scopeId = 'fixture-delayed-' + randomUUID();
    child.relayProcessTree = { scopeId, confirmStopped: () => new Promise(resolve => { release = resolve; }),
      closeConfirmed() { closeCalls++; } };
    const supervisor = new SdkProcessSupervisor({ graceMs: 0 });
    supervisor.attach(child); supervisor.markSpawnSettled();
    let resolved = false;
    supervisor.whenExited().then(() => { resolved = true; });
    child.exitCode = 0; child.emit('exit', 0, null);
    await delay(100);
    assert.equal(resolved, false, 'elapsed caller deadline cannot manufacture successful tree confirmation');
    assert.equal(closeCalls, 0);
    release({ stopConfirmed: true, processTree: true, scopeId, activeProcesses: 0, pendingExits: 0 });
    assert.equal((await bounded(supervisor.whenExited(), 'delayed receipt')).stopConfirmed, true);
    report.checks.push('A stalled confirmation remains pending past the caller deadline, then closes only after verified release.');
  }

  const started = Date.now();
  let survivor;
  try {
    await assertReceiptIsolation();
    survivor = await ready(launch('unrelated-B'));
    const stopped = await ready(launch('explicit-stop-A'));
    assertSurvivor(survivor);
    const first = stopped.supervisor.stop();
    assert.equal(stopped.supervisor.stop(), first, 'stop is idempotent');
    await confirmAndRemove(stopped, await bounded(first, 'explicit stop confirmation'));
    assertSurvivor(survivor);
    report.checks.push('Stopping A releases root, detached child, detached grandchild and their cwd; concurrent B is unaffected.');

    const natural = await ready(launch('natural-root-exit-A'));
    fs.writeFileSync(path.join(natural.cwd, 'exit-root'), 'exit');
    await confirmAndRemove(natural, await bounded(natural.supervisor.whenExited(), 'natural root exit confirmation'));
    assertSurvivor(survivor);
    report.checks.push('Natural root exit also reclaims all descendants before confirming close; concurrent B remains alive.');

    const crashed = await ready(launch('launcher-crash-A'));
    // Invoke the native handle operation on this fixture's exact ChildProcess,
    // bypassing its Job-aware kill wrapper to simulate a launcher crash.
    assert.equal(cp.ChildProcess.prototype.kill.call(crashed.child, 'SIGKILL'), true);
    await confirmAndRemove(crashed, await bounded(crashed.supervisor.whenExited(), 'launcher crash cleanup'));
    assertSurvivor(survivor);
    report.checks.push('Unexpected launcher death still reclaims its SDK tree using retained Job ownership; B is unaffected.');

    const pressured = await ready(launch('spawn-pressure-A', { churn: true }));
    fs.writeFileSync(path.join(pressured.cwd, 'start-churn'), 'start');
    await until(() => fs.readdirSync(pressured.cwd).filter(name => /^churn-\d+\.json$/.test(name)).length >= 3,
      'continuous child spawning before stop');
    const pressuredClosed = await bounded(pressured.supervisor.stop(), 'stop while children are spawning');
    pressured.members.push(...fs.readdirSync(pressured.cwd).filter(name => /^churn-\d+\.json$/.test(name)).map(name =>
      ({ pid: Number(name.match(/^churn-(\d+)\.json$/)[1]), stage: 3, cwd: pressured.cwd, nonce: pressured.nonce })));
    await confirmAndRemove(pressured, pressuredClosed);
    assertSurvivor(survivor);
    report.checks.push('Stopping during continuous descendant creation closes process admission, releases all observed members and preserves B.');

    const early = launch('early-stop-A');
    const closedEarly = await bounded(early.supervisor.stop(), 'stop before launcher handshake');
    early.members = [0, 1, 2].map(stage => path.join(early.cwd, 'stage-' + stage + '.json'))
      .filter(file => fs.existsSync(file)).map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    await confirmAndRemove(early, closedEarly);
    assertSurvivor(survivor);
    report.checks.push('Stop before launcher readiness leaves no late-started process or locked scratch directory.');

    await confirmAndRemove(survivor, await bounded(survivor.supervisor.stop(), 'final cleanup B'));
    report.checks.push('B is independently stopped and removed only by the fixture final cleanup.');
    report.ok = true;
  } catch (error) {
    report.errors.push({ message: error.message, stack: error.stack, code: error.code, path: error.path, syscall: error.syscall, errno: error.errno });
    process.exitCode = 1;
  } finally {
    for (const fixture of fixtures) {
      if (fixture.supervisor.snapshot().exited) continue;
      try {
        const receipt = await bounded(fixture.supervisor.stop(), 'owned fixture cleanup ' + fixture.label, 5000);
        report.scenarios.push({ label: fixture.label, cleanup: true, receipt, errors: fixture.errors,
          stderr: fixture.stderr.slice(-3000), lifecycle: fixture.lifecycle });
      } catch (error) {
        // Do not search for processes or terminate a PID taken from a file.
        // Only the handles returned by this fixture's own launches are used.
        try { fixture.child.kill('SIGKILL'); } catch (_) {}
        report.errors.push({ message: 'Fixture cleanup failed: ' + fixture.label + ': ' + error.message });
        report.ok = false; process.exitCode = 1;
      }
    }
    report.elapsedMs = Date.now() - started;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ok: report.ok, node: report.node, electron: report.electron,
      elapsedMs: report.elapsedMs, checks: report.checks, errors: report.errors, output }, null, 2));
  }
}
