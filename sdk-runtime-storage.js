'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Runtime scratch/cache is independent of Claude's resource/configuration home.
// Existing SDK sessions, credentials, skills and user rules keep their source.
function createSdkRuntimeStorage({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0')) {
    throw new TypeError('Relay SDK 数据目录必须是绝对路径');
  }
  const base = path.resolve(dataDir);
  const root = path.join(base, 'sdk-runtime');
  const tmpDir = path.join(root, 'tmp');
  const cacheDir = path.join(root, 'cache');
  const debugDir = path.join(root, 'debug');
  function contained(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  function prepare() {
    fs.mkdirSync(base, { recursive: true });
    const actualBase = fs.realpathSync(base);
    // Validate each level before creating anything below it. An existing link
    // must not redirect new runtime files outside Relay's private data root.
    fs.mkdirSync(root, { recursive: true });
    const actualRoot = fs.realpathSync(root);
    if (!contained(actualBase, actualRoot) || actualBase === actualRoot) throw new Error('SDK 数据目录不能链接到 Relay 数据目录之外');
    for (const dir of [tmpDir, cacheDir, debugDir]) {
      fs.mkdirSync(dir, { recursive: true });
      const actual = fs.realpathSync(dir);
      if (!contained(actualRoot, actual) || actualRoot === actual) throw new Error('SDK 缓存目录不能链接到专属目录之外');
    }
    return { root, tmpDir, cacheDir, debugDir };
  }
  function apply(environment = {}) {
    prepare();
    const env = { ...environment };
    for (const key of Object.keys(env)) {
      if (['CLAUDE_CODE_TMPDIR', 'XDG_CACHE_HOME', 'CLAUDE_CODE_DEBUG_LOGS_DIR'].includes(key.toUpperCase())) delete env[key];
    }
    env.CLAUDE_CODE_TMPDIR = tmpDir;
    env.XDG_CACHE_HOME = cacheDir;
    env.CLAUDE_CODE_DEBUG_LOGS_DIR = debugDir;
    return env;
  }
  return Object.freeze({ root, tmpDir, cacheDir, debugDir, prepare, apply });
}

module.exports = { createSdkRuntimeStorage };
