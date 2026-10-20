'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachResponsivenessDiagnostics } = require('../src/main/app/responsiveness-diagnostics');

function fixture() {
  let time = 0, tick, cpu = 0, canceled = false, unrefed = false;
  const records = [], win = new EventEmitter(), powerMonitor = new EventEmitter();
  win.webContents = new EventEmitter();
  win.isVisible = () => true;
  win.isMinimized = () => false;
  const monitor = attachResponsivenessDiagnostics({ win, powerMonitor,
    logger: { warn: (_format, json) => records.push(JSON.parse(json)) },
    runningCount: () => 3, now: () => time, cpuUsage: () => ({ user: cpu, system: 0 }),
    memoryUsage: () => ({ rss: 100 * 1048576, heapUsed: 20 * 1048576 }),
    schedule(callback) { tick = callback; return { unref() { unrefed = true; } }; },
    cancel() { canceled = true; },
  });
  return { records, win, powerMonitor, monitor,
    advance(ms, cpuMs = 0) { time += ms; cpu += cpuMs * 1000; tick(); },
    status: () => ({ canceled, unrefed }),
  };
}

test('normal ticks do not log; a late main tick records only bounded metadata', () => {
  const f = fixture();
  f.advance(1000); f.advance(1749);
  assert.equal(f.records.length, 0);
  f.advance(1750, 600);
  assert.deepEqual(f.records, [{ kind: 'main-loop-delay', delayMs: 750, sampleMs: 1750,
    mainCpuMs: 600, runningTasks: 3, mainRssMiB: 100, mainHeapMiB: 20,
    windowVisible: true, windowMinimized: false, suppressed: 0 }]);
  assert.equal(f.status().unrefed, true);
});

test('repeated stalls are rate limited independently from native window events', () => {
  const f = fixture();
  f.advance(2000);
  for (let i = 0; i < 10; i++) f.advance(2000);
  f.win.emit('unresponsive');
  f.advance(1000);
  f.win.emit('responsive');
  assert.deepEqual(f.records.map(x => x.kind), ['main-loop-delay', 'window-unresponsive', 'window-responsive']);
  assert.equal(f.records[2].durationMs, 1000);
  f.advance(9000);
  assert.equal(f.records[3].kind, 'main-loop-delay');
  assert.equal(f.records[3].suppressed, 10);
});

test('system sleep and the first resumed sample are not reported as app stalls', () => {
  const f = fixture();
  f.powerMonitor.emit('suspend');
  f.advance(3600000);
  f.win.emit('unresponsive');
  f.powerMonitor.emit('resume');
  f.win.emit('responsive');
  f.advance(5000); f.advance(1000);
  assert.equal(f.records.length, 0);
  f.advance(2000);
  assert.equal(f.records[0].kind, 'main-loop-delay');
});

test('renderer exit diagnostics allow only fixed reasons and numeric codes', () => {
  const f = fixture();
  f.win.webContents.emit('render-process-gone', {}, { reason: 'secret from page', exitCode: 'private', url: 'private' });
  assert.equal(f.records[0].reason, 'other');
  assert.equal(f.records[0].exitCode, null);
  assert.equal(JSON.stringify(f.records).includes('private'), false);
  assert.equal(JSON.stringify(f.records).includes('secret'), false);
});

test('closing the window removes sampling and native/power listeners', () => {
  const f = fixture();
  f.win.emit('closed'); f.monitor.dispose();
  f.advance(5000); f.win.emit('unresponsive');
  assert.equal(f.records.length, 0);
  assert.equal(f.status().canceled, true);
  assert.equal(f.win.eventNames().length, 0);
  assert.equal(f.win.webContents.eventNames().length, 0);
  assert.equal(f.powerMonitor.eventNames().length, 0);
});
