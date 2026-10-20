'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { withDrainedExit } = require('../src/main/sdk/sdk-process-adapter');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 123; child.exitCode = null; child.signalCode = null;
  child.kill = signal => { child.signalCode = signal; return true; };
  return child;
}

test('custom process stderr preserves split UTF-8 and completes forwarding before exit', async () => {
  const child = fakeChild(), chunks = [], exits = [];
  const facade = withDrainedExit(child, { onStderr: text => chunks.push(text) });
  facade.once('exit', code => exits.push({ code, text: chunks.join('') }));
  const bytes = Buffer.from('诊断🧪完成');
  for (const byte of bytes) child.stderr.write(Buffer.from([byte]));
  child.exitCode = 7; child.emit('exit', 7, null);
  assert.equal(exits.length, 0);
  child.stderr.end(); await tick();
  assert.equal(chunks.join(''), '诊断🧪完成');
  assert.deepEqual(exits, [{ code: 7, text: '诊断🧪完成' }]);
  assert.equal(facade.stderr, child.stderr); assert.equal(facade.pid, child.pid);
  assert.equal(facade.stdin, child.stdin); assert.equal(facade.exitCode, 7);
});

test('stderr drains even with no observer, throwing observer or rejected observer', async () => {
  for (const onStderr of [undefined, () => { throw Error('observer'); }, () => Promise.reject(Error('observer'))]) {
    const child = fakeChild(); withDrainedExit(child, { onStderr });
    for (let index = 0; index < 32; index++) child.stderr.write(Buffer.alloc(65536, 120));
    await tick();
    assert.equal(child.stderr.readableLength, 0); assert.equal(child.stderr.writableLength, 0);
    assert.doesNotThrow(() => child.stderr.emit('error', Error('read error')));
    child.stderr.end(); child.emit('exit', 0, null); await tick();
  }
});

test('stderr close flushes truncated UTF-8 only once and exit grace remains bounded', async () => {
  const child = fakeChild(), chunks = [], exits = [];
  const facade = withDrainedExit(child, { graceMs: 10, onStderr: text => chunks.push(text) });
  facade.on('exit', code => exits.push(code)); child.stderr.write(Buffer.from([0xe8, 0xaf]));
  child.emit('exit', 2, null);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.deepEqual(exits, [2]);
  child.stderr.destroy(); await tick(); assert.equal(chunks.join(''), '\ufffd');
  child.stderr.emit('close'); assert.equal(chunks.join(''), '\ufffd');
  assert.deepEqual(exits, [2]);
});

test('real child completes 2 MiB synchronous stderr before writing its stdout result', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['-e', "const fs=require('node:fs');const b=Buffer.alloc(65536,120);for(let i=0;i<32;i++){let p=0;while(p<b.length)p+=fs.writeSync(2,b,p,b.length-p);}fs.writeSync(1,'PIPE_RESULT');"], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let bytes = 0, output = '';
  const facade = withDrainedExit(child, { onStderr: text => { bytes += Buffer.byteLength(text); } });
  child.stdout.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { facade.once('exit', resolve); child.once('error', reject); });
  assert.equal(code, 0); assert.equal(output, 'PIPE_RESULT'); assert.equal(bytes, 2 * 1024 * 1024);
});
