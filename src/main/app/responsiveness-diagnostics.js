'use strict';

const { performance } = require('node:perf_hooks');

// An exception-free UI freeze otherwise leaves no trace in main.log. These
// records contain only timings/counts, never SDK frames or conversation text.
// A blocked main loop can report only after recovering; this is not a watchdog
// that can diagnose a process killed while still blocked.
function attachResponsivenessDiagnostics({
  win, logger, runningCount = () => 0, powerMonitor,
  now = () => performance.now(), cpuUsage = () => process.cpuUsage(),
  memoryUsage = () => process.memoryUsage(),
  schedule = setInterval, cancel = clearInterval,
  intervalMs = 1000, thresholdMs = 750, cooldownMs = 30000,
}) {
  let disposed = false, suspended = false, skipSample = false;
  let previousAt = now(), previousCpu = cpuUsage();
  let unresponsiveAt = null;
  const reports = new Map();
  const listeners = [];
  const number = value => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  function reset() { previousAt = now(); previousCpu = cpuUsage(); }
  function listen(emitter, event, callback) {
    if (!emitter?.on) return;
    emitter.on(event, callback);
    listeners.push(() => emitter.removeListener?.(event, callback));
  }
  function report(kind, fields = {}) {
    if (disposed || suspended) return;
    const at = now(), last = reports.get(kind);
    if (last && at - last.at < cooldownMs) { last.suppressed += 1; return; }
    try {
      const memory = memoryUsage();
      const record = { kind, ...fields, runningTasks: number(runningCount()),
        mainRssMiB: number(memory.rss / 1048576), mainHeapMiB: number(memory.heapUsed / 1048576),
        windowVisible: Boolean(win.isVisible?.()), windowMinimized: Boolean(win.isMinimized?.()),
        suppressed: last?.suppressed || 0 };
      reports.set(kind, { at, suppressed: 0 });
      logger.warn('[responsiveness] %s', JSON.stringify(record));
    } catch (_) { /* Diagnostics must not disrupt a task or window lifecycle. */ }
  }
  function sample() {
    if (disposed || suspended) return;
    try {
      const at = now(), cpu = cpuUsage(), elapsedMs = at - previousAt;
      const cpuMs = (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000;
      previousAt = at; previousCpu = cpu;
      if (skipSample || elapsedMs < 0) { skipSample = false; return; }
      const delayMs = elapsedMs - intervalMs;
      if (delayMs >= thresholdMs) report('main-loop-delay', {
        delayMs: number(delayMs), sampleMs: number(elapsedMs), mainCpuMs: number(cpuMs),
      });
    } catch (_) {}
  }
  listen(win, 'unresponsive', () => {
    if (disposed || suspended) return;
    if (unresponsiveAt === null) unresponsiveAt = now();
    report('window-unresponsive');
  });
  listen(win, 'responsive', () => {
    if (unresponsiveAt === null) return;
    const durationMs = number(now() - unresponsiveAt);
    unresponsiveAt = null;
    report('window-responsive', { durationMs });
  });
  listen(win.webContents, 'render-process-gone', (_event, details = {}) => {
    const known = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'];
    report('renderer-exited', { reason: known.includes(details.reason) ? details.reason : 'other',
      exitCode: Number.isSafeInteger(details.exitCode) ? details.exitCode : null });
  });
  listen(powerMonitor, 'suspend', () => { suspended = true; unresponsiveAt = null; reset(); });
  listen(powerMonitor, 'resume', () => { suspended = false; skipSample = true; unresponsiveAt = null; reset(); });
  const timer = schedule(sample, intervalMs);
  timer?.unref?.();
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel(timer);
    for (const remove of listeners) remove();
    listeners.length = 0;
    reports.clear();
  }
  listen(win, 'closed', dispose);
  return { dispose };
}

module.exports = { attachResponsivenessDiagnostics };
