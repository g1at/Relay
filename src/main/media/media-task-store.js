'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const queues = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value);

// Private request bodies and output references are never a plaintext fallback.
// Without OS encryption they survive only for the lifetime of this instance.
class MediaTaskStore {
  constructor({ userDataDir, directory, seal, unseal, fsImpl = fs } = {}) {
    if (!directory && !userDataDir) throw new Error('Media task storage directory is required');
    this.directory = directory || path.join(userDataDir, 'media-tasks');
    this.fs = fsImpl;
    this.seal = seal;
    this.unseal = unseal;
    this.private = new Map();
    this.ready = this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  file(id) {
    if (!validId(id)) throw new Error('Invalid media task ID');
    return path.join(this.directory, `${id}.json`);
  }

  async save(task, payload) {
    const file = this.file(task.id);
    const record = { version: 1, task: clone(task), protectedPayload: null };
    if (payload !== undefined) this.private.set(task.id, clone(payload));
    const privateValue = this.private.get(task.id);
    const pending = (queues.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      await this.ready;
      if (privateValue !== undefined && typeof this.seal === 'function' && typeof this.unseal === 'function') {
        try {
          const encrypted = await this.seal(JSON.stringify(privateValue));
          if (typeof encrypted !== 'string' && !Buffer.isBuffer(encrypted)) throw new Error('Invalid sealed payload');
          record.protectedPayload = { encoding: Buffer.isBuffer(encrypted) ? 'base64' : 'utf8', data: Buffer.isBuffer(encrypted) ? encrypted.toString('base64') : encrypted };
          record.task.payloadPersistence = 'encrypted';
        } catch (_) { record.task.payloadPersistence = 'memory_only'; }
      } else record.task.payloadPersistence = privateValue === undefined ? 'none' : 'memory_only';
      if (!record.protectedPayload) {
        // An unavailable OS key must not delete the last recoverable encrypted
        // payload. New values stay marked memory_only if encryption failed.
        try {
          const stat = await this.fs.lstat(file);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 192 * 1024 * 1024) {
            const prior = JSON.parse(await this.fs.readFile(file, 'utf8'));
            if (prior.version === 1 && prior.task?.id === task.id && prior.protectedPayload) {
              record.protectedPayload = prior.protectedPayload;
              if (privateValue === undefined) record.task.payloadPersistence = 'encrypted';
            }
          }
        } catch (_) { /* A missing prior payload remains unavailable. */ }
      }
      // Defense in depth for accidental runtime objects containing credentials.
      record.task = JSON.parse(JSON.stringify(record.task, (key, value) => /^(api[-_]?key|x-api-key|authorization|proxy-authorization|password|secret|accessToken|refreshToken)$/i.test(key) ? undefined : value));
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await this.fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        await this.fs.rename(temporary, file);
      } finally { await this.fs.unlink(temporary).catch(() => {}); }
    });
    queues.set(file, pending);
    try { await pending; } finally { if (queues.get(file) === pending) queues.delete(file); }
    return clone(record.task);
  }

  async load(id) {
    const file = this.file(id);
    await this.ready;
    if (queues.has(file)) await queues.get(file);
    let record;
    try {
      const stat = await this.fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 192 * 1024 * 1024) throw new Error('Invalid media task record');
      record = JSON.parse(await this.fs.readFile(file, 'utf8'));
      if (record.version !== 1 || record.task?.id !== id) throw new Error('Invalid media task record');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return { task: { id, taskId: id, state: 'needs_attention', error: { code: 'MEDIA_TASK_CORRUPT', message: '媒体任务记录无法读取' } }, payload: null, sensitiveUnavailable: true };
    }
    let payload = this.private.get(id);
    if (payload === undefined && record.protectedPayload && typeof this.unseal === 'function') {
      try {
        const sealed = record.protectedPayload;
        const text = await this.unseal(sealed.encoding === 'base64' ? Buffer.from(sealed.data, 'base64') : sealed.data);
        payload = JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : text);
        this.private.set(id, payload);
      } catch (_) { /* Missing OS key must not turn into a new paid submission. */ }
    }
    return { task: clone(record.task), payload: payload === undefined ? null : clone(payload), sensitiveUnavailable: payload === undefined && record.task.payloadPersistence !== 'none' };
  }

  async get(id) { return (await this.load(id))?.task || null; }

  async list({ conversationId, states } = {}) {
    await this.ready;
    const names = await this.fs.readdir(this.directory);
    const records = await Promise.all(names.filter(name => name.endsWith('.json') && validId(name.slice(0, -5))).map(name => this.get(name.slice(0, -5))));
    return records.filter(task => task && (conversationId === undefined || task.conversationId === conversationId) && (!states || states.includes(task.state)))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
}

module.exports = { MediaTaskStore };
