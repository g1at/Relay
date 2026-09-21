'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

// Metadata invalidates the bounded read cache, not the SDK context. An editor's
// touch/atomic save with identical contents must not restart a warmed Query.
const contentCache = new Map();
const MAX_CACHE_ENTRIES = 4096, MAX_CACHE_BYTES = 4 * 1024 * 1024;
const CACHE_STABLE_MS = 2000;
const RUNTIME_FINGERPRINT_VERSION = 2;
const legacyComparisons = new Map();
let contentCacheBytes = 0;
function statKey(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size,
    stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs].join(':');
}
function semanticJson(value) {
  if (Array.isArray(value)) return value.map(semanticJson);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, semanticJson(value[key])])) : value;
}
function cacheContent(key, value) {
  const previous = contentCache.get(key);
  if (previous) { contentCacheBytes -= previous.bytes; contentCache.delete(key); }
  value.bytes = 256 + 2 * (key.length + value.signature.length + value.digest.length
    + value.references.reduce((sum, reference) => sum + reference.length, 0));
  if (value.bytes > MAX_CACHE_BYTES) return;
  contentCache.set(key, value); contentCacheBytes += value.bytes;
  while (contentCache.size > MAX_CACHE_ENTRIES || contentCacheBytes > MAX_CACHE_BYTES) {
    const oldest = contentCache.keys().next().value;
    contentCacheBytes -= contentCache.get(oldest).bytes; contentCache.delete(oldest);
  }
}

// Fingerprint effective instruction/configuration inputs whose SDK snapshot
// survives resume. Retain hashes and import paths, never whole instructions.
function instructionFingerprint({ cwd, configDir, settingSources = ['user'], homeDir = os.homedir(), legacy = false }) {
  const files = [], ruleRoots = [], metadata = [], seen = new Set(), realRuleDirectories = new Set();
  // Rules can include imports. Bound traversal and retain only hashes/stat
  // metadata; neither complete instructions nor user/project names are logged.
  const maxFiles = 2048, maxDepth = 8, maxReadBytes = 2 * 1024 * 1024;
  let bytesRead = 0;
  if (settingSources.includes('user')) {
    files.push(path.join(configDir, 'settings.json'), path.join(configDir, 'CLAUDE.md'));
    ruleRoots.push(path.join(configDir, 'rules'));
  }
  if (settingSources.includes('project')) {
    let dir = path.resolve(cwd);
    while (true) {
      files.push(path.join(dir, 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md'), path.join(dir, '.claude', 'settings.json'));
      ruleRoots.push(path.join(dir, '.claude', 'rules'));
      if (settingSources.includes('local')) files.push(path.join(dir, 'CLAUDE.local.md'), path.join(dir, '.claude', 'settings.local.json'));
      const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
    }
  }
  function imports(text) {
    const clean = text.replace(/^\s*(`{3,}|~{3,}).*\r?\n[\s\S]*?^\s*\1\s*$/gm, '').replace(/`[^`\n]*`/g, '');
    const values = [], pattern = /(?:^|\s|\()@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s`<>()[\]{}]+))/gm;
    let match;
    while ((match = pattern.exec(clean))) {
      const reference = (match[1] || match[2] || match[3]).replace(/[.,;:]+$/, '');
      if (!reference || reference.includes('\0') || reference.includes('://') || reference.includes('@')) continue;
      values.push(reference);
    }
    return values;
  }
  function visitFile(file, depth = 0, parseReferences = /\.md$/i.test(file), physicalPath = null) {
    const key = path.resolve(file);
    if (seen.has(key)) return;
    if (seen.size >= maxFiles) { metadata.push(['file-limit', key]); return; }
    seen.add(key);
    try {
      if (legacy) {
        // Exact pre-v2 algorithm, used only to prove an old persisted handle
        // still represents the same inputs before migrating its internal hash.
        const link = fs.lstatSync(key), stat = fs.statSync(key);
        metadata.push([key, stat.size, stat.mtimeMs, stat.ctimeMs, link.isSymbolicLink() ? fs.readlinkSync(key) : null]);
        if (!stat.isFile() || !parseReferences || depth >= 5 || stat.size > 256 * 1024 || bytesRead + stat.size > maxReadBytes) return;
        const text = fs.readFileSync(key, 'utf8'); bytesRead += stat.size;
        metadata.push([key, crypto.createHash('sha256').update(text).digest('hex')]);
        for (const reference of imports(text)) {
          const imported = reference.startsWith('~/') || reference.startsWith('~\\') ? path.join(homeDir, reference.slice(2))
            : path.isAbsolute(reference) ? reference : path.resolve(path.dirname(key), reference);
          visitFile(imported, depth + 1, true);
        }
        return;
      }
      const link = fs.lstatSync(key, { bigint: true });
      const target = link.isSymbolicLink() ? fs.readlinkSync(key) : null;
      const stat = target === null ? link : fs.statSync(key, { bigint: true });
      const real = target !== null || !physicalPath ? fs.realpathSync(key) : physicalPath;
      if (!stat.isFile()) { metadata.push([key, 'not-file', target, real]); return; }
      const size = Number(stat.size), signature = [statKey(link), statKey(stat), target, real].join('|');
      if (bytesRead + size > maxReadBytes) {
        // Oversized input remains conservative: never claim unchanged content
        // without reading it. This is the existing finite traversal/read guard.
        metadata.push([key, 'read-limit', signature]); return;
      }
      // Charge represented bytes even on a cache hit so cache eviction cannot
      // change which files reach the deterministic read/import boundary.
      bytesRead += size;
      let content = contentCache.get(key);
      // Some filesystems coalesce consecutive writes even in their nanosecond
      // fields. Re-read recent/future-dated files until that granularity window
      // passes, so same-size rapid saves cannot hide behind a cached digest.
      const stable = Date.now() - Math.max(Number(link.mtimeMs), Number(link.ctimeMs),
        Number(stat.mtimeMs), Number(stat.ctimeMs)) >= CACHE_STABLE_MS;
      if (!stable || !content || content.signature !== signature) {
        const buffer = fs.readFileSync(key);
        let digestInput = buffer;
        if (/\.json$/i.test(key)) {
          try { digestInput = JSON.stringify(semanticJson(JSON.parse(buffer.toString('utf8')))); }
          catch (_) {} // Invalid/extended JSON stays byte-sensitive, never silently ignored.
        }
        content = { signature, digest: crypto.createHash('sha256').update(digestInput).digest('hex'),
          references: size <= 256 * 1024 ? imports(buffer.toString('utf8')) : [] };
        cacheContent(key, content);
      }
      metadata.push([key, 'file', target, real, content.digest]);
      if (!parseReferences || depth >= 5) return;
      for (const reference of content.references) {
        const imported = reference.startsWith('~/') || reference.startsWith('~\\') ? path.join(homeDir, reference.slice(2))
          : path.isAbsolute(reference) ? reference : path.resolve(path.dirname(key), reference);
        visitFile(imported, depth + 1, true);
      }
    } catch (_) { metadata.push([key, null]); }
  }
  function visitRules(directory, depth = 0) {
    const key = path.resolve(directory);
    if (seen.has(key)) return;
    if (seen.size >= maxFiles || depth >= maxDepth) { metadata.push(['directory-limit', key]); return; }
    seen.add(key);
    try {
      const link = fs.lstatSync(key);
      const target = link.isSymbolicLink() ? fs.readlinkSync(key) : null;
      if (legacy) metadata.push([key, link.mtimeMs, link.ctimeMs, target]);
      const stat = !legacy && target === null ? link : fs.statSync(key);
      if (!stat.isDirectory()) { if (!legacy) metadata.push([key, 'not-directory', target]); return; }
      const real = fs.realpathSync(key);
      if (!legacy) metadata.push([key, 'directory', target, real]);
      if (realRuleDirectories.has(real)) return;
      realRuleDirectories.add(real);
      const entries = fs.readdirSync(key, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (seen.size >= maxFiles) { metadata.push(['entry-limit', key, entries.length]); break; }
        const child = path.join(key, entry.name);
        let directory = entry.isDirectory();
        if (entry.isSymbolicLink()) { try { directory = fs.statSync(child).isDirectory(); } catch (_) {} }
        if (directory) visitRules(child, depth + 1);
        else if (/\.md$/i.test(entry.name)) visitFile(child, 0, true, path.join(real, entry.name));
      }
    } catch (_) { metadata.push([key, null]); }
  }
  files.forEach(file => visitFile(file));
  ruleRoots.forEach(root => visitRules(root));
  return crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
}
function runtimeContractFingerprint(policy, nativeAgent, instructions) {
  return crypto.createHash('sha256').update(JSON.stringify(['relay-sdk-contract-v1', policy.fingerprint,
    nativeAgent?.fingerprint || null, instructions])).digest('hex');
}
function contractFingerprints(policy, nativeAgent, instructions) {
  const policySnapshot = { fingerprint: policy.fingerprint };
  const agentSnapshot = nativeAgent ? { fingerprint: nativeAgent.fingerprint } : null;
  const inputs = { ...instructions, settingSources: [...(instructions.settingSources || ['user'])] };
  const fingerprint = runtimeContractFingerprint(policySnapshot, agentSnapshot, instructionFingerprint(inputs));
  let previous, checked = false;
  return {
    fingerprint,
    fingerprintVersion: RUNTIME_FINGERPRINT_VERSION,
    legacyFingerprint: () => {
      if (!checked) {
        previous = runtimeContractFingerprint(policySnapshot, agentSnapshot, instructionFingerprint({ ...inputs, legacy: true }));
        // Do not pair legacy metadata with a different content snapshot if an
        // editor changed inputs between the two reads. This check runs only for
        // a legacy candidate, never on ordinary v2 sends.
        if (runtimeContractFingerprint(policySnapshot, agentSnapshot, instructionFingerprint(inputs)) !== fingerprint) previous = null;
        checked = true;
      }
      return previous;
    },
  };
}
function migrateLegacyRuntimeContract(record, contract) {
  const previous = record?.sdkRuntimeFingerprint;
  if (!record?.sessionId || !previous || previous === contract?.fingerprint
      || record.sdkRuntimeFingerprintVersion === RUNTIME_FINGERPRINT_VERSION
      || typeof contract?.legacyFingerprint !== 'function') return null;
  const key = previous + ':' + contract.fingerprint;
  let matches = legacyComparisons.get(key);
  if (matches === undefined) {
    matches = previous === contract.legacyFingerprint();
    legacyComparisons.set(key, matches);
    if (legacyComparisons.size > 256) legacyComparisons.delete(legacyComparisons.keys().next().value);
  }
  if (!matches) return null;
  const migrated = JSON.parse(JSON.stringify(record));
  migrated.sdkRuntimeFingerprint = contract.fingerprint;
  migrated.sdkRuntimeFingerprintVersion = RUNTIME_FINGERPRINT_VERSION;
  for (const scope of [migrated.sdkSessionContext, ...(migrated.turns || []).map(turn => turn?.sdkSessionContext)]) {
    if (scope?.routing?.runtimeFingerprint === previous) {
      scope.routing.runtimeFingerprint = contract.fingerprint;
      scope.routing.runtimeFingerprintVersion = RUNTIME_FINGERPRINT_VERSION;
    }
  }
  return migrated;
}
function requiresFreshContract(saved, fingerprint) {
  return !!saved?.sessionId && saved.sdkRuntimeFingerprint !== fingerprint;
}
module.exports = { instructionFingerprint, runtimeContractFingerprint, requiresFreshContract,
  contractFingerprints, migrateLegacyRuntimeContract, RUNTIME_FINGERPRINT_VERSION };
