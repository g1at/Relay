'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_BYTES = 1024 * 1024;
const MAX_RUNS = 8;
const MAX_ITEMS = 128;
const MAX_CONVERSATION_TOMBSTONES = 1024;
const MAX_RUN_TOMBSTONES = 2048;
const STATUSES = new Set(['running', 'finishing', 'complete', 'failed', 'canceled', 'interrupted']);
const SOURCES = new Set(['write-tool', 'output-delta', 'final-reference']);
const failure = (code, message) => Object.assign(new Error(message || code), { code });
const missing = error => error?.code === 'ENOENT';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
function validId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id);
}
function requireId(id) { if (!validId(id)) throw failure('INVALID_DELIVERY_ID'); return id; }
function normalize(snapshot, conversationId, runId) {
  if (!plain(snapshot) || snapshot.version !== 1 || snapshot.conversationId !== conversationId || snapshot.runId !== runId
    || !string(snapshot.turnTs, 128) || !STATUSES.has(snapshot.status) || typeof snapshot.complete !== 'boolean'
    || !Array.isArray(snapshot.items) || snapshot.items.length > MAX_ITEMS
    || !Array.isArray(snapshot.warnings) || snapshot.warnings.length > 128
    || snapshot.warnings.some(value => !string(value, 512))) throw failure('INVALID_DELIVERY_SNAPSHOT');
  const items = snapshot.items.map(item => {
    if (!plain(item) || !string(item.id, 256) || !string(item.path, 4096) || !string(item.name, 1024)
      || !Number.isSafeInteger(item.size) || item.size < 0 || !Number.isFinite(item.mtimeMs) || item.mtimeMs < 0
      || !SOURCES.has(item.source) || !(item.toolUseId === null || string(item.toolUseId, 4096))) throw failure('INVALID_DELIVERY_ITEM');
    return { id: item.id, path: item.path, name: item.name, size: item.size, mtimeMs: item.mtimeMs, source: item.source, toolUseId: item.toolUseId };
  });
  return { version: 1, conversationId, runId, turnTs: snapshot.turnTs, status: snapshot.status, items,
    complete: snapshot.complete, warnings: [...snapshot.warnings] };
}
function bytes(value) {
  const result = Buffer.from(JSON.stringify(value), 'utf8');
  if (result.length > MAX_BYTES) throw failure('DELIVERY_PROGRESS_TOO_LARGE');
  return result;
}
function tombstones(maximum) {
  const ids = new Map();
  return {
    has(id) { if (!ids.has(id)) return false; ids.delete(id); ids.set(id, true); return true; },
    add(id) { ids.delete(id); ids.set(id, true); while (ids.size > maximum) ids.delete(ids.keys().next().value); },
  };
}

// Keep one instance per app process. Snapshot data is held only while queued;
// completed queues are released. canWrite is the durable conversation-existence
// guard after bounded in-memory deletion tombstones have aged out.
function createDeliveryProgressStore({ rootDir, canWrite = () => true, fileSystem = fs.promises } = {}) {
  if (!string(rootDir, 4096) || !path.isAbsolute(rootDir)) throw failure('INVALID_DELIVERY_ROOT');
  if (typeof canWrite !== 'function') throw new TypeError('canWrite must be a function');
  const root = path.resolve(rootDir);
  const queues = new Map();
  const deleting = new Map();
  const deleted = tombstones(MAX_CONVERSATION_TOMBSTONES);
  const removedRuns = tombstones(MAX_RUN_TOMBSTONES);
  const runKey = (conversationId, runId) => conversationId + '/' + runId;
  const fileFor = conversationId => path.join(root, conversationId + '.json');
  const blocked = conversationId => deleting.has(conversationId) || deleted.has(conversationId);
  async function writable(conversationId) {
    if (blocked(conversationId)) throw failure('DELIVERY_CONVERSATION_DELETED');
    if (await canWrite(conversationId) !== true) throw failure('DELIVERY_PROGRESS_NOT_WRITABLE');
    if (blocked(conversationId)) throw failure('DELIVERY_CONVERSATION_DELETED');
  }
  async function load(conversationId) {
    let handle;
    try {
      const file = fileFor(conversationId);
      const before = await fileSystem.lstat(file);
      if (!before.isFile() || before.isSymbolicLink()) throw failure('INVALID_DELIVERY_FILE');
      if (before.size > MAX_BYTES) throw failure('DELIVERY_PROGRESS_TOO_LARGE');
      handle = await fileSystem.open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw failure('DELIVERY_PROGRESS_CHANGED');
      if (stat.size > MAX_BYTES) throw failure('DELIVERY_PROGRESS_TOO_LARGE');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw failure('DELIVERY_PROGRESS_TOO_LARGE');
      let value;
      try { value = JSON.parse(buffer.toString('utf8', 0, length)); }
      catch (_) { throw failure('INVALID_DELIVERY_PROGRESS_JSON'); }
      if (!plain(value) || value.version !== 1 || !plain(value.items) || Object.keys(value.items).length > MAX_RUNS) throw failure('INVALID_DELIVERY_PROGRESS');
      const records = Object.create(null);
      for (const [runId, snapshot] of Object.entries(value.items)) records[requireId(runId)] = normalize(snapshot, conversationId, runId);
      return records;
    } catch (error) {
      if (missing(error)) return Object.create(null);
      throw error;
    } finally { if (handle) await handle.close(); }
  }
  async function unlink(file) { try { await fileSystem.unlink(file); } catch (error) { if (!missing(error)) throw error; } }
  async function replace(conversationId, records, checkWrite) {
    const data = bytes({ version: 1, items: records });
    const temporary = path.join(root, '.' + conversationId + '.' + randomUUID() + '.tmp');
    let handle;
    try {
      await fileSystem.mkdir(root, { recursive: true });
      handle = await fileSystem.open(temporary, 'wx', 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close(); handle = null;
      if (checkWrite) await writable(conversationId);
      await fileSystem.rename(temporary, fileFor(conversationId));
    } finally {
      if (handle) await handle.close();
      await unlink(temporary);
    }
  }
  function stateFor(conversationId) {
    let state = queues.get(conversationId);
    if (!state) { state = { conversationId, ops: [], running: false }; queues.set(conversationId, state); }
    return state;
  }
  function kick(state) {
    if (state.running) return;
    state.running = true;
    queueMicrotask(async () => {
      try {
        while (state.ops.length) {
          const op = state.ops.shift();
          try {
            let result;
            if (op.type === 'save') {
              // removeRun may invalidate one queued run without dropping its peers.
              for (const runId of [...op.snapshots.keys()]) if (removedRuns.has(runKey(state.conversationId, runId))) {
                op.snapshots.delete(runId);
                for (const waiter of op.waiters) if (waiter.runId === runId) waiter.reject(failure('DELIVERY_RUN_REMOVED'));
              }
              if (op.snapshots.size) {
                await writable(state.conversationId);
                const records = await load(state.conversationId);
                for (const [runId, snapshot] of op.snapshots) records[runId] = snapshot;
                if (Object.keys(records).length > MAX_RUNS) throw failure('DELIVERY_PROGRESS_RUN_LIMIT');
                await replace(state.conversationId, records, true);
              }
            } else if (op.type === 'read') {
              result = blocked(state.conversationId) ? [] : Object.values(await load(state.conversationId));
            } else if (op.type === 'remove-run') {
              const records = await load(state.conversationId);
              if (Object.hasOwn(records, op.runId)) {
                delete records[op.runId];
                if (Object.keys(records).length) await replace(state.conversationId, records, false);
                else await unlink(fileFor(state.conversationId));
              }
            } else if (op.type === 'remove-conversation') {
              await unlink(fileFor(state.conversationId));
            }
            for (const waiter of op.waiters) waiter.resolve(result);
          } catch (error) { for (const waiter of op.waiters) waiter.reject(error); }
        }
      } finally { state.running = false; if (queues.get(state.conversationId) === state) queues.delete(state.conversationId); }
    });
  }
  function enqueue(conversationId, operation) {
    const state = stateFor(conversationId);
    const promise = new Promise((resolve, reject) => { operation.waiters = [{ resolve, reject }]; state.ops.push(operation); });
    kick(state); return promise;
  }
  async function save(snapshot) {
    const conversationId = requireId(snapshot?.conversationId), runId = requireId(snapshot?.runId);
    if (blocked(conversationId)) throw failure('DELIVERY_CONVERSATION_DELETED');
    if (removedRuns.has(runKey(conversationId, runId))) throw failure('DELIVERY_RUN_REMOVED');
    const value = normalize(snapshot, conversationId, runId);
    bytes({ version: 1, items: { [runId]: value } });
    const state = stateFor(conversationId);
    let operation = state.ops.at(-1);
    if (operation?.type !== 'save') { operation = { type: 'save', snapshots: new Map(), waiters: [] }; state.ops.push(operation); }
    if (!operation.snapshots.has(runId) && operation.snapshots.size >= MAX_RUNS) throw failure('DELIVERY_PROGRESS_RUN_LIMIT');
    operation.snapshots.set(runId, value);
    const promise = new Promise((resolve, reject) => operation.waiters.push({ runId, resolve, reject }));
    kick(state); return promise;
  }
  async function read(conversationId) { requireId(conversationId); return enqueue(conversationId, { type: 'read' }); }
  async function removeRun(conversationId, runId) {
    requireId(conversationId); requireId(runId);
    removedRuns.add(runKey(conversationId, runId));
    return enqueue(conversationId, { type: 'remove-run', runId });
  }
  async function removeConversation(conversationId) {
    requireId(conversationId);
    if (deleting.has(conversationId)) return deleting.get(conversationId);
    deleted.add(conversationId);
    const removal = enqueue(conversationId, { type: 'remove-conversation' });
    deleting.set(conversationId, removal);
    try { await removal; } finally { deleting.delete(conversationId); }
  }
  return { save, read, removeRun, removeConversation };
}

module.exports = { createDeliveryProgressStore, MAX_BYTES, MAX_RUNS, MAX_ITEMS,
  MAX_CONVERSATION_TOMBSTONES, MAX_RUN_TOMBSTONES };
