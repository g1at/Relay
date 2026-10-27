'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { releaseExitedPtyResources } = require('../src/main/workspace/pty-exit-cleanup');
const options = { platform: 'win32', version: '1.1.0' };
function fixture() {
  const calls = [];
  const connection = { _useConptyDll: false, _isDisposed: false, _worker: { terminate() {} },
    dispose() { if (!this._isDisposed) { this._isDisposed = true; calls.push('worker'); } } };
  const pty = { _agent: { _useConpty: true, _useConptyDll: false, _exitCode: 7, _conoutSocketWorker: connection,
    _inSocket: { destroy() { calls.push('input'); } }, _outSocket: { destroy() { calls.push('output'); } } },
    kill() { throw Error('must never kill an exited PID'); }, destroy() { throw Error('must never destroy via public kill'); } };
  return { pty, calls, connection };
}
test('natural exit releases only its owned native worker and streams, once', () => {
  const f = fixture();
  assert.equal(releaseExitedPtyResources(f.pty, { exitCode: 7 }, options), true);
  assert.deepEqual(f.calls, ['worker', 'input', 'output']);
  assert.equal(releaseExitedPtyResources(f.pty, { exitCode: 7 }, options), true);
  assert.deepEqual(f.calls, ['worker', 'input', 'output']);
});
test('an active or mismatched terminal is never released', () => {
  for (const code of [undefined, 0]) { const f = fixture(); f.pty._agent._exitCode = code;
    assert.equal(releaseExitedPtyResources(f.pty, { exitCode: 7 }, options), false); assert.deepEqual(f.calls, []); }
  const f = fixture(); assert.equal(releaseExitedPtyResources(f.pty, null, options), false); assert.deepEqual(f.calls, []);
});
test('other platforms, versions and unknown native shapes safely remain untouched', () => {
  for (const changed of [{ platform: 'linux' }, { version: '1.2.0' }]) { const f = fixture();
    assert.equal(releaseExitedPtyResources(f.pty, { exitCode: 7 }, { ...options, ...changed }), false); assert.deepEqual(f.calls, []); }
  for (const change of [f => delete f.pty._agent, f => f.pty._agent._useConptyDll = true,
    f => delete f.connection._worker, f => delete f.pty._agent._inSocket.destroy]) {
    const f = fixture(); change(f); assert.equal(releaseExitedPtyResources(f.pty, { exitCode: 7 }, options), false); assert.deepEqual(f.calls, []);
  }
});
test('active-kill cleanup already in progress is not rearmed and never kills again', () => {
  const f = fixture(); f.connection.dispose(); f.calls.length = 0;
  assert.equal(releaseExitedPtyResources(f.pty, { exitCode: 7 }, options), true);
  assert.deepEqual(f.calls, ['input', 'output']);
});
test('one native resource failure does not prevent releasing the remaining owned streams', () => {
  const f = fixture(); f.connection.dispose = () => { throw Error('native close failed'); };
  assert.doesNotThrow(() => releaseExitedPtyResources(f.pty, { exitCode: 7 }, options));
  assert.deepEqual(f.calls, ['input', 'output']);
});
