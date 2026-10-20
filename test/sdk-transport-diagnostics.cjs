'use strict';

/**
 * Opt-in SDK transport diagnostics; deliberately excluded from npm test.
 *
 *   node test/sdk-transport-diagnostics.cjs --run
 *   node test/sdk-transport-diagnostics.cjs --run --output /tmp/sdk-transport.json
 *
 * Reads the installed SDK, verifies its version and exact bytes, and extracts
 * three class declarations with Acorn. Only those declarations run in a VM.
 * Query/ProcessTransport constructors are never called; transports and streams
 * are in-memory fixtures. No native CLI, real SDK query, model, network or user
 * profile is involved. No vendor/product file is changed.
 *
 * These observations describe the pinned SDK; focused assertions also preserve
 * the reviewed synchronous-failure cleanup and cancel-queued wire contracts.
 * A fixed SDK must be reviewed before updating the identity/AST contract below.
 * Host-side queues cannot establish the cause of native CLI CPU/RSS growth or
 * prove that any failure branch occurred in a live Relay conversation.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const SDK_DIR = path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const SUPPORTED = Object.freeze({
  version: '0.3.283',
  sha256: 'd88abad1360f675dda417c9a6ce7395447d0892b77735529083d10ea4fbdd242',
});
const SHAPES = {
  xu: { role: 'ordinary-message queue', members: 15, methods: ['next', 'enqueue', 'done', 'error', 'return'] },
  qx: { role: 'ProcessTransport', members: 35, methods: ['write', 'close', 'readMessages', 'waitForExit'] },
  Xg: { role: 'Query', members: 136, methods: ['initialize', 'buildInitializeRequest', 'request', 'interrupt', 'readMessages', 'handleControlRequest', 'handleHookCallbacks'] },
};
const HELP = `Opt-in, in-memory SDK transport diagnostics (no native processes or model calls).

Usage: node test/sdk-transport-diagnostics.cjs --run [--output <json-path>]
       node test/sdk-transport-diagnostics.cjs --help

Without --run, no SDK is read or executed and no result file is written.
Default output: .codex-tmp/sdk-transport-diagnostics/result.json
Supported SDK: ${SUPPORTED.version}, SHA-256 ${SUPPORTED.sha256}
Version/hash/AST drift or unavailable Node Acorn fails explicitly (exit 2).
Harness/scenario errors exit 1; completed diagnostics exit 0, including findings.

Eight scenarios:
  1. Callback ID reuse across repeated initialize calls.
  2. Control dispatch while 5000 ordinary events have no public consumer.
  3. Missing callback error response and cancel-controller cleanup.
  4. Hook response writes into a stalled in-memory stdin (backpressure).
  5. Pending request cleanup after synchronous transport write failure.
  6. Pending request cleanup after asynchronous write rejection (comparison).
  7. Retention limit for unmatched control responses.
  8. Cancel-queued interrupt request and sanitized cancellation receipts.

Additional check: Windows close ordering with controlled timers and a fake child.

Findings concern the Node/Electron host. They do not prove live native CLI
stall/RSS causes. This diagnostic is intentionally outside default tests.
`;

function unsupported(message) {
  return Object.assign(new Error(message), { code: 'UNSUPPORTED_DIAGNOSTIC_TARGET' });
}

function parseOptions(args) {
  const options = { run: false, help: false, output: path.join(ROOT, '.codex-tmp', 'sdk-transport-diagnostics', 'result.json') };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--run') options.run = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--output' && args[index + 1] && !args[index + 1].startsWith('--')) options.output = path.resolve(args[++index]);
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return options;
}

function extractClasses(report) {
  const bytes = fs.readFileSync(path.join(SDK_DIR, 'sdk.mjs'));
  const { version } = JSON.parse(fs.readFileSync(path.join(SDK_DIR, 'package.json'), 'utf8'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  report.sdk = { file: path.relative(ROOT, path.join(SDK_DIR, 'sdk.mjs')), version, sha256, supported: SUPPORTED };
  if (version !== SUPPORTED.version || sha256 !== SUPPORTED.sha256) {
    throw unsupported('SDK version/hash drift: review the installed source before updating this diagnostic. Nothing was evaluated.');
  }

  // Acorn is bundled in the supported Node runtime. Avoid a new dependency or
  // importing the SDK module, whose top-level code is outside this experiment.
  const acornSource = process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'];
  if (typeof acornSource !== 'string') throw unsupported('Node bundled Acorn is unavailable; no fallback text extraction is allowed.');
  const parserModule = new Module('relay-sdk-diagnostic-acorn');
  parserModule._compile(acornSource, 'relay-sdk-diagnostic-acorn.cjs');
  const source = bytes.toString('utf8');
  const ast = parserModule.exports.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  report.parser = { name: 'Node bundled Acorn', version: parserModule.exports.version };
  const closeDelays = ast.body.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations).filter(node => node.id?.name === 'iFe');
  if (closeDelays.length !== 1 || closeDelays[0].init?.type !== 'Literal' || closeDelays[0].init.value !== 2000) {
    throw unsupported('AST drift in ProcessTransport close delay; no class was evaluated.');
  }
  report.constants = { closeGraceMs: closeDelays[0].init.value };
  const toolHostRequests = ast.body.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations).find(node => node.id?.name === 'DG')?.init;
  const expectedToolHostRequests = ['remote_tool_call', 'remote_plumbing_call', 'remote_tools_probe', 'remote_tools_reannounce'];
  if (toolHostRequests?.type !== 'ArrayExpression'
      || JSON.stringify(toolHostRequests.elements.map(node => node.type === 'Literal' ? node.value : null)) !== JSON.stringify(expectedToolHostRequests)) {
    throw unsupported('AST drift in tool-host control routing; no class was evaluated.');
  }
  report.constants.toolHostRequests = expectedToolHostRequests;
  report.extracted = [];
  const classes = {};
  for (const [name, shape] of Object.entries(SHAPES)) {
    const matches = ast.body.filter(node => node.type === 'ClassDeclaration' && node.id?.name === name);
    if (matches.length !== 1) throw unsupported(`AST drift: expected exactly one top-level ${name} class.`);
    const node = matches[0];
    const methods = node.body.body.filter(member => member.type === 'MethodDefinition' && !member.computed).map(member => member.key.name);
    if (node.superClass || node.body.body.length !== shape.members || !shape.methods.every(method => methods.includes(method))) {
      throw unsupported(`AST drift in ${name} (${shape.role}); no class was evaluated.`);
    }
    classes[name] = source.slice(node.start, node.end);
    report.extracted.push({ name, role: shape.role, start: node.start, end: node.end,
      originalLine: node.loc.start.line, members: node.body.body.length, verifiedMethods: shape.methods });
  }
  return classes;
}

function loadClasses(classes, overrides = {}) {
  const sandbox = {
    AbortController, Symbol, Promise, Map, Set, JSON, Math, Error, Buffer,
    V() {}, jt() {}, ie: JSON.stringify, Ke: JSON.parse,
    Gt: error => error?.message || String(error), kl: Symbol('suppressControlResponse'),
    Cn: error => error instanceof Error ? error : Error(String(error)),
    Kt: (error, extra) => Object.assign(error, extra), xG: () => Error('Aborted'),
    Pn: class AbortError extends Error {},
    Yx: () => Error('Query closed'), Mt: (_name, operation) => operation(),
    DG: ['remote_tool_call', 'remote_plumbing_call', 'remote_tools_probe', 'remote_tools_reannounce'],
    setTimeout, clearTimeout, ...overrides,
  };
  vm.createContext(sandbox);
  for (const [name, source] of Object.entries(classes)) {
    vm.runInContext(`${source}; globalThis.${name} = ${name};`, sandbox, { filename: `installed-sdk-${name}.js`, timeout: 1000 });
  }
  return sandbox;
}

async function diagnose({ xu: Kf, qx: nk, Xg: jy }, report, classes) {
  // Do not call the Query/ProcessTransport constructors: those start I/O.
  const fakeQuery = transport => Object.assign(Object.create(jy.prototype), {
    transport, isSingleUserTurn: false, pendingControlResponses: new Map(), unmatchedControlResponses: new Map(),
    cancelControllers: new Map(), hookCallbacks: new Map(), sdkMcpServers: new Map(), pendingMcpResponses: new Map(),
    inputStream: new Kf(), cleanupCallbacks: [], nextCallbackId: 0, cleanupPerformed: false,
    initializeHasBeenWritten: true, sdkMcpToolsChangedDuringCapture: new Set(),
    cleanup() { this.cleanupPerformed = true; this.inputStream.done(); },
  });
  const hook = (id = 'hook-request', callback = 'hook_0') => ({
    type: 'control_request', request_id: id,
    request: { subtype: 'hook_callback', callback_id: callback, input: { hook_event_name: 'FileChanged', file_path: 'synthetic.txt' } },
  });
  const record = (name, observation) => report.scenarios.push({ name, status: 'completed', ...observation });

  const init = fakeQuery({ write() {} });
  init.hooks = { FileChanged: [{ hooks: [async () => ({})] }] };
  init.request = async () => ({ response: {} });
  for (let index = 0; index < 100; index++) await init.initialize();
  record('reinitialize_reuses_callback_ids', {
    initializations: 100, callbackCount: init.hookCallbacks.size, nextCallbackId: init.nextCallbackId,
    idsReused: init.hookCallbacks.size === 1 && init.nextCallbackId === 1,
  });

  let releaseReader;
  const gate = new Promise(resolve => { releaseReader = resolve; });
  const writes = [], ordinary = 5000;
  const query = fakeQuery({
    async *readMessages() {
      for (let index = 0; index < ordinary; index++) yield { type: 'stream_event', event: {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' },
      } };
      yield hook();
      yield { type: 'control_response', response: { subtype: 'success', request_id: 'outbound', response: { ok: true } } };
      await gate;
    },
    write(text) { writes.push(JSON.parse(text)); },
  });
  let callbackCalls = 0, controlReceipts = 0;
  query.hookCallbacks.set('hook_0', async () => { callbackCalls++; return {}; });
  query.pendingControlResponses.set('outbound', {
    handler() { controlReceipts++; query.pendingControlResponses.delete('outbound'); }, reject() {},
  });
  const reading = query.readMessages();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(query.inputStream.queue.length, ordinary, 'fixture did not enqueue its ordinary messages');
    record('control_dispatch_without_public_message_consumer', {
      queuedOrdinaryEvents: query.inputStream.queue.length, callbackCalls, controlReceipts,
      responseWrites: writes.length, cancelControllers: query.cancelControllers.size,
      pendingControlResponses: query.pendingControlResponses.size,
      controlDispatchCompleted: callbackCalls === 1 && controlReceipts === 1 && writes[0]?.response.request_id === 'hook-request',
    });
  } finally { releaseReader(); await reading; }

  const invalid = [];
  const bad = fakeQuery({ write: text => invalid.push(JSON.parse(text)) });
  await bad.handleControlRequest(hook('bad-hook', 'missing-id'));
  record('missing_callback_returns_error_and_releases_controller', {
    response: invalid[0]?.response.subtype, error: invalid[0]?.response.error,
    cancelControllers: bad.cancelControllers.size,
  });

  // The sink deliberately never acknowledges the first write. Subsequent bytes
  // occupy the Node host Writable buffer; they are not native CLI allocations.
  let actualSinkWrites = 0;
  const sink = new Writable({ highWaterMark: 1024, write(_data, _encoding, _done) { actualSinkWrites++; } });
  sink.on('error', () => {});
  const nativeTransport = Object.assign(Object.create(nk.prototype), {
    abortController: new AbortController(), ready: true, processStdin: sink, process: { killed: false, exitCode: null },
  });
  const flooded = fakeQuery(nativeTransport);
  flooded.hookCallbacks.set('hook_0', async () => ({}));
  const started = performance.now(), hookRequests = 8192;
  try {
    for (let index = 0; index < hookRequests; index++) await flooded.handleControlRequest(hook(`file-${index}`));
    assert.equal(actualSinkWrites, 1, 'the fixture sink must remain stalled');
    record('process_transport_stdin_backpressure', {
      hookRequests, completedHandlers: hookRequests, actualSinkWrites, bufferedBytes: sink.writableLength,
      highWaterMark: sink.writableHighWaterMark, needsDrain: sink.writableNeedDrain,
      cancelControllers: flooded.cancelControllers.size,
      handlersCompletedWithoutDrain: sink.writableNeedDrain && sink.writableLength > sink.writableHighWaterMark,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    });
  } finally { sink.destroy(); }

  // Source review confirms 0.3.283 deletes entries on both failure paths. Keep
  // these assertions so a diagnostic cannot silently re-endorse the old leak.
  const broken = fakeQuery({ write() { throw Error('Synthetic not-ready transport'); } });
  for (let index = 0; index < 256; index++) {
    await assert.rejects(broken.request({ subtype: 'get_context_usage' }), /Synthetic not-ready/);
  }
  assert.equal(broken.pendingControlResponses.size, 0, 'synchronous write failures must release pending requests');
  record('sync_write_failure_pending_requests', { rejectedRequests: 256, pendingAfterRejections: broken.pendingControlResponses.size });
  const rejecting = fakeQuery({ write() { return Promise.reject(Error('Synthetic asynchronous failure')); } });
  for (let index = 0; index < 256; index++) {
    await assert.rejects(rejecting.request({ subtype: 'get_context_usage' }), /Synthetic asynchronous/);
  }
  assert.equal(rejecting.pendingControlResponses.size, 0, 'asynchronous write failures must release pending requests');
  record('async_write_failure_pending_requests', { rejectedRequests: 256, pendingAfterRejections: rejecting.pendingControlResponses.size });

  const unknown = fakeQuery({ async *readMessages() {
    for (let index = 0; index < 3000; index++) {
      yield { type: 'control_response', response: { request_id: `late-${index}`, subtype: 'success', response: {} } };
    }
  } });
  await unknown.readMessages();
  record('unmatched_control_receipt_retention', { received: 3000, retained: unknown.unmatchedControlResponses.size,
    configuredCap: jy.UNMATCHED_CONTROL_RESPONSES_MAX });

  const cancelFrames = [];
  const cancellable = fakeQuery({ write(text) {
    const frame = JSON.parse(text); cancelFrames.push(frame);
    queueMicrotask(() => cancellable.pendingControlResponses.get(frame.request_id)?.handler({
      subtype: 'success', request_id: frame.request_id,
      response: { still_queued: ['queued-turn', 1], cancelled: ['cancelled-turn', null] },
    }));
  } });
  const receipt = JSON.parse(JSON.stringify(await cancellable.interrupt({ cancelQueued: true })));
  assert.deepEqual(cancelFrames[0].request, { subtype: 'interrupt', cancel_queued: true });
  assert.deepEqual(receipt, { still_queued: ['queued-turn'], cancelled: ['cancelled-turn'] });
  assert.equal(cancellable.pendingControlResponses.size, 0);
  record('cancel_queued_interrupt_receipt', { request: cancelFrames[0].request, receipt,
    pendingAfterReceipt: cancellable.pendingControlResponses.size });

  // Exercise the exact close method without sleeping, spawning, or terminating
  // anything. This validates scheduling only, not Windows OS kill effectiveness.
  const timers = [], steps = [];
  const closing = loadClasses(classes, {
    process: { platform: 'win32' }, iFe: report.constants.closeGraceMs,
    Yg: () => Error('Synthetic aborted transport'), Zg: { untrack() { steps.push('untrack'); } },
    setTimeout(callback, delay, ...args) { timers.push({ callback, delay, args }); return { unref() {} }; },
  });
  const child = Object.assign(new EventEmitter(), {
    killed: false, exitCode: null, signalCode: null,
    stdin: { end() { steps.push('stdin.end'); } },
    kill(signal) { steps.push(`kill:${signal}`); this.killed = true; return true; },
  });
  const controller = new AbortController(), forwarded = new AbortController();
  forwarded.signal.addEventListener('abort', () => steps.push('forwarded.abort'));
  const transport = Object.assign(Object.create(closing.qx.prototype), {
    abortController: controller, forwardedAbort: forwarded, process: child, processStdin: child.stdin,
    exitListeners: [], ready: true,
  });
  transport.abortHandler = () => transport.close();
  controller.signal.addEventListener('abort', transport.abortHandler);
  controller.abort();
  const delaysMs = [];
  while (timers.length) {
    assert.ok(delaysMs.length < 4, 'unexpected repeated close timers');
    const timer = timers.shift();
    delaysMs.push(timer.delay);
    steps.push(`timer:${timer.delay}`);
    timer.callback(...timer.args);
  }
  record('windows_close_controlled_timer_order', {
    delaysMs, scheduledKillDelayMs: delaysMs.reduce((total, delay) => total + delay, 0), steps,
    fakeChildKillRequested: child.killed,
    nativeExitProven: false,
  });
}

async function main() {
  let options;
  try { options = parseOptions(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\n\n${HELP}`); process.exitCode = 2; return; }
  if (options.help || !options.run) { console.log(HELP); return; }
  const report = { at: new Date().toISOString(), node: process.versions.node, status: 'running',
    scope: 'Exact installed SDK class extraction with in-memory transports; no native CLI or real SDK query.',
    boundaries: [
      'Buffers and maps belong to the Node/Electron host, not native CLI memory.',
      'A stalled synthetic sink does not prove live stdin was blocked.',
      'Synchronous write failure is not the normal writable.write(false) branch.',
      'No live FileChanged hook timeout, native CPU/RSS or event-loop stall attribution is made.',
    ], scenarios: [] };
  let deadline;
  try {
    const classes = extractClasses(report);
    await Promise.race([
      diagnose(loadClasses(classes), report, classes),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Diagnostic exceeded its 10-second deadline')), 10000); }),
    ]);
    report.status = 'completed';
  } catch (error) {
    report.status = error.code === 'UNSUPPORTED_DIAGNOSTIC_TARGET' ? 'unsupported-sdk-or-parser' : 'diagnostic-error';
    report.error = { code: error.code || null, message: error.message };
    process.exitCode = error.code === 'UNSUPPORTED_DIAGNOSTIC_TARGET' ? 2 : 1;
  } finally { clearTimeout(deadline); }
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, output: options.output }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
