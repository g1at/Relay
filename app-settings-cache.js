'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_CACHE_BYTES = 1024 * 1024;

// Cache raw disk JSON only. Callers receive their own deep copy so migrations,
// failed writes and nested settings edits cannot mutate the cached disk state.
function createAppSettingsCache({ fileSystem = fs } = {}) {
  let cached = null;
  const fingerprint = stat => [stat.dev, stat.ino, stat.size,
    stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].join(':');

  function invalidate() { cached = null; }

  function read(file) {
    try {
      const filename = path.resolve(file);
      const before = fingerprint(fileSystem.statSync(filename, { bigint: true }));
      if (cached && cached.filename === filename && cached.fingerprint === before) {
        return structuredClone(cached.value);
      }
      // Never keep another file, a stale snapshot, or a failed read/parse alive.
      invalidate();
      const text = fileSystem.readFileSync(filename, 'utf8');
      const value = JSON.parse(text);
      const after = fingerprint(fileSystem.statSync(filename, { bigint: true }));
      // An external writer can replace the file between stat and read. Return
      // this read's snapshot, but only retain it when the file stayed stable.
      if (before === after && Buffer.byteLength(text, 'utf8') <= MAX_CACHE_BYTES) {
        cached = { filename, fingerprint: after, value };
      }
      return structuredClone(value);
    } catch (error) {
      invalidate();
      throw error;
    }
  }

  return { read, invalidate };
}

module.exports = { createAppSettingsCache, MAX_CACHE_BYTES };
