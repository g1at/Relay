'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const marked = require('../../../renderer/vendor/marked.umd.js');
const { parse: parseLocalLink } = require('../../../renderer/local-file-links');
const { nativePath } = require('../app/output-library');
const { locationKey, isWithinLocation } = require('./task-file-links');

const DEFAULT_LIMITS = Object.freeze({ beginBudgetMs: 100, finishBudgetMs: 1500, maxEntries: 1000,
  maxDirectories: 100, maxDepth: 4, maxCandidates: 128, maxReferences: 128, maxRuns: 128 });
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DELIVERY_EXTENSIONS = new Set(('md markdown mdown pdf doc docx odt rtf ppt pptx odp xls xlsx xlsm xlsb ods csv tsv html htm '
  + 'png jpg jpeg gif webp avif bmp svg tif tiff mp3 wav ogg mp4 webm mov zip 7z tar gz tgz').split(' '));
const SCRIPT_EXTENSIONS = new Set('py pyw sh bash zsh ps1 bat cmd js mjs cjs ipynb r rb pl'.split(' '));
// Project instructions and routine repository documentation are not implicit
// handoffs. An explicit final reference can still select one intentionally.
const PROJECT_GUIDANCE = /^(?:agents|claude|skill|readme|contributing|code_of_conduct|security|support|license|licence|copying|notice|changelog|changes|authors)(?:[._-](?:local|[a-z]{2}(?:[-_][a-z]{2,4})?))?$/i;
const isProjectGuidance = file => {
  const extension = path.extname(file).toLowerCase();
  return ['', '.md', '.markdown', '.mdown', '.txt', '.rst'].includes(extension)
    && PROJECT_GUIDANCE.test(path.basename(file, path.extname(file)));
};

const sameBasename = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code);
const owner = event => {
  const parent = event?.parent_tool_use_id || event?.parentToolUseId;
  if (parent) return String(parent);
  if (event?.agent_id) return 'agent:' + event.agent_id;
  // A subtype identifies a child role, not a unique child. Without its parent
  // or agent ID, neither its requests nor its receipts can certify root work.
  return event?.subagent_type ? null : '';
};
const absolute = value => /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value || '');
const clone = value => JSON.parse(JSON.stringify(value));
const boundedString = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
const failure = code => Object.assign(new Error(code), { code });

// These are selected-file references, not proof that the model created a file.
// Inline basenames may only match this run's verified candidates; no directory search.
function finalReferences(text, cwd, maximum) {
  if (typeof text !== 'string' || !text) return { entries: [], truncated: false };
  if (text.length > 256 * 1024) return { entries: [], truncated: true };
  const entries = []; let truncated = false;
  try {
    marked.walkTokens(marked.lexer(text), token => {
      const inline = token.type === 'codespan';
      if (!inline && !['link', 'image'].includes(token.type)) return;
      const raw = inline ? token.text : token.href;
      if (!boundedString(raw)) return;
      const parsed = parseLocalLink(raw);
      if (!parsed || parsed.line || !boundedString(parsed.path)) return;
      if (entries.length >= maximum) { truncated = true; return; }
      const basename = inline && !/[\\/]/.test(parsed.path) && !absolute(parsed.path);
      const native = absolute(parsed.path) ? nativePath(parsed.path) : path.resolve(cwd, parsed.path);
      if (native) entries.push({ path: native, basename: basename ? parsed.path : null });
    });
  } catch (_) { truncated = true; }
  return { entries, truncated };
}

function createDeliveryRegistry({ onUpdate, limits = {}, fileSystem = fs.promises, now = Date.now } = {}) {
  const cap = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, value]) => [key,
    Number.isSafeInteger(limits[key]) && limits[key] >= 0 ? limits[key] : value]));
  const runs = new Map();
  function warn(run, code) { run.complete = false; if (!run.warnings.includes(code) && run.warnings.length < 20) run.warnings.push(code); }
  function snapshot(runId) {
    const run = runs.get(runId); if (!run) return null;
    return clone({ version: 1, conversationId: run.conversationId, runId: run.runId, turnTs: run.turnTs,
      status: run.status, items: [...run.items.values()], complete: run.complete, warnings: run.warnings });
  }
  function notify(run) {
    if (typeof onUpdate !== 'function' || runs.get(run.runId) !== run) return;
    const value = snapshot(run.runId);
    Promise.resolve().then(() => onUpdate(value)).catch(() => {});
  }
  function overlaps(left, right) { return !!left && !!right && (isWithinLocation(left, right) || isWithinLocation(right, left)); }
  function conflicts(run) {
    for (const other of runs.values()) {
      if (other === run || !['running', 'finishing'].includes(other.status)) continue;
      if ([run.scanRoot, run.realScanRoot].filter(Boolean).some(a => [other.scanRoot, other.realScanRoot].filter(Boolean).some(b => overlaps(a, b)))) {
        run.conflicted = other.conflicted = true;
        warn(run, 'SHARED_OUTPUT_CONCURRENT_RUN'); warn(other, 'SHARED_OUTPUT_CONCURRENT_RUN');
        for (const current of [run, other]) {
          for (const [key, item] of current.items) if (item.source === 'output-delta') current.items.delete(key);
          for (const [key, item] of current.candidates) if (!item.toolUseId) current.candidates.delete(key);
        }
      }
    }
  }
  async function bounded(ms, operation) {
    let expired = false, timer;
    const assertTime = () => { if (expired) throw failure('TIME_BUDGET'); };
    try {
      return await Promise.race([Promise.resolve().then(() => operation(assertTime)), new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(failure('TIME_BUDGET')); }, ms);
      })]);
    } finally { expired = true; clearTimeout(timer); }
  }
  async function safeDirectory(directory, assertTime) {
    assertTime(); const stat = await fileSystem.lstat(directory); assertTime();
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_OUTPUT_ROOT');
    const real = await fileSystem.realpath(directory); assertTime();
    return real;
  }
  function inScratch(run, value) { return run.scratchRoots.some(root => isWithinLocation(value, root)); }
  async function resolveScratchRoots(run, assertTime) {
    for (const scratch of [...run.scratchRoots]) {
      if (run.resolvedScratchRoots.has(scratch)) continue;
      try {
        assertTime(); const real = await fileSystem.realpath(scratch); assertTime();
        if (!run.scratchRoots.includes(real)) run.scratchRoots.push(real);
        run.resolvedScratchRoots.add(scratch); run.resolvedScratchRoots.add(real);
      } catch (error) { assertTime(); if (!missing(error)) throw error; }
    }
  }
  async function scan(run, assertTime) {
    let root;
    try { root = await safeDirectory(run.scanRoot, assertTime); }
    catch (error) { if (missing(error)) throw failure('OUTPUT_ROOT_MISSING'); throw error; }
    if (run.realScanRoot && locationKey(root) !== locationKey(run.realScanRoot)) throw failure('OUTPUT_ROOT_CHANGED');
    await resolveScratchRoots(run, assertTime);
    if (inScratch(run, root)) throw failure('SCRATCH_OUTPUT_OVERLAP');
    const files = new Map(); let entries = 0, directories = 0;
    async function visit(directory, depth) {
      assertTime(); if (++directories > cap.maxDirectories) throw failure('DIRECTORY_LIMIT');
      const list = await fileSystem.opendir(directory);
      try {
        assertTime();
        for await (const entry of list) {
          assertTime(); if (++entries > cap.maxEntries) throw failure('ENTRY_LIMIT');
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink() || inScratch(run, file)) continue;
          const stat = await fileSystem.lstat(file); assertTime();
          if (stat.isSymbolicLink()) continue;
          const real = await fileSystem.realpath(file); assertTime();
          if (!isWithinLocation(real, root) || inScratch(run, real)) continue;
          if (stat.isDirectory()) {
            if (depth >= cap.maxDepth) throw failure('DEPTH_LIMIT');
            await visit(real, depth + 1);
          } else if (stat.isFile()) files.set(locationKey(real), { path: real, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
        }
      } finally { await list.close().catch(() => {}); }
    }
    await visit(root, 0); return { root, files };
  }
  function resolvePath(run, value, cwd = run.cwd) {
    if (!boundedString(value)) return null;
    const resolved = absolute(value) ? nativePath(value) : path.resolve(nativePath(cwd) || run.cwd, value);
    // Do not trigger arbitrary SMB access from model-authored path strings.
    if (!resolved || /^(?:\\\\|\/\/)/.test(resolved) && !/^(?:\\\\|\/\/)wsl(?:\.localhost|\$)[\\/]/i.test(resolved)) return null;
    return resolved;
  }
  async function inspect(run, value, assertTime) {
    const candidate = resolvePath(run, value); if (!candidate || inScratch(run, candidate)) return null;
    await resolveScratchRoots(run, assertTime);
    if (inScratch(run, candidate)) return null;
    assertTime(); const stat = await fileSystem.lstat(candidate); assertTime();
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parent = await fileSystem.realpath(path.dirname(candidate)); assertTime();
    const real = await fileSystem.realpath(candidate); assertTime();
    if (!isWithinLocation(real, parent) || inScratch(run, real)) return null;
    // Recheck a file that could have been replaced while its parent resolved.
    const actual = await fileSystem.lstat(real); assertTime();
    if (!actual.isFile() || actual.isSymbolicLink() || stat.ino !== actual.ino || stat.dev !== actual.dev) return null;
    return { path: real, name: path.basename(real), size: actual.size, mtimeMs: actual.mtimeMs };
  }
  function put(run, file, source, toolUseId = null) {
    const key = locationKey(file.path), previous = run.items.get(key);
    if (!previous && run.items.size >= cap.maxCandidates) { warn(run, 'ITEM_LIMIT'); return; }
    const priority = { 'final-reference': 0, 'output-delta': 1, 'write-tool': 2 };
    if (previous && priority[previous.source] > priority[source]) return;
    run.items.set(key, { id: crypto.createHash('sha256').update(run.runId + '\0' + key).digest('hex').slice(0, 24), ...file, source, toolUseId });
  }
  function queueSuccess(run, intent) {
    if (intent.settled) return; intent.settled = true;
    run.pending = run.pending.then(async () => {
      if (runs.get(run.runId) !== run || !['running', 'finishing'].includes(run.status)) return;
      try {
        const checked = await bounded(Math.min(cap.finishBudgetMs, 250), async assertTime => {
          const file = await inspect(run, intent.path, assertTime);
          if (!file) return null;
          let declaredOutput = false;
          if (DELIVERY_EXTENSIONS.has(path.extname(file.path).slice(1).toLowerCase())
            && !isProjectGuidance(file.path) && isWithinLocation(intent.path, run.outputDir)) {
            // This checks one declared root and one receipt-backed file. It does
            // not enumerate cwd or infer ownership from shared project contents.
            const realOutputDir = await fileSystem.realpath(run.outputDir); assertTime();
            declaredOutput = isWithinLocation(file.path, realOutputDir);
          }
          return { file, declaredOutput };
        });
        if (!checked || run.closed || runs.get(run.runId) !== run) return;
        const { file, declaredOutput } = checked;
        if (run.candidates.size >= cap.maxCandidates && !run.candidates.has(locationKey(file.path))) { warn(run, 'CANDIDATE_LIMIT'); return; }
        run.candidates.set(locationKey(file.path), { ...file, toolUseId: intent.id });
        if (!isProjectGuidance(file.path) && (declaredOutput
          || run.scanRoot && isWithinLocation(file.path, run.realScanRoot || run.scanRoot))) {
          put(run, file, 'write-tool', intent.id); notify(run);
        }
      } catch (error) { if (!run.closed && !missing(error)) warn(run, error.code || 'FILE_CHECK_FAILED'); }
    });
  }
  async function begin(input = {}) {
    if (!boundedString(input.runId) || !boundedString(input.conversationId) || !boundedString(input.turnTs)) throw failure('DELIVERY_IDENTITY_REQUIRED');
    if (runs.has(input.runId)) {
      const current = runs.get(input.runId);
      if (current.conversationId !== input.conversationId || current.turnTs !== input.turnTs) throw failure('DELIVERY_IDENTITY_MISMATCH');
      return snapshot(input.runId);
    }
    if (runs.size >= cap.maxRuns) {
      for (const [id, run] of runs) { if (!['running', 'finishing'].includes(run.status)) runs.delete(id); if (runs.size < cap.maxRuns) break; }
      if (runs.size >= cap.maxRuns) throw failure('DELIVERY_RUN_LIMIT');
    }
    const cwd = nativePath(input.cwd), outputDir = nativePath(input.outputDir || input.cwd);
    if (!cwd || !outputDir) throw failure('DELIVERY_PATH_REQUIRED');
    const scanRoot = input.allowOutputScan === false ? null : locationKey(cwd) === locationKey(outputDir) ? path.join(cwd, 'outputs') : outputDir;
    const run = { conversationId: input.conversationId, runId: input.runId, turnTs: input.turnTs, cwd, outputDir,
      scanRoot, realScanRoot: null, scratchRoots: [input.scratchDir, ...(input.previousScratchDirs || [])].map(nativePath).filter(Boolean),
      resolvedScratchRoots: new Set(), status: 'running', items: new Map(), candidates: new Map(), intents: new Map(), complete: true, warnings: [], pending: Promise.resolve(),
      baseline: null, conflicted: false, startedAt: now() };
    runs.set(run.runId, run); conflicts(run);
    if (scanRoot) {
      try {
        const result = await bounded(cap.beginBudgetMs, async assertTime => {
          try { run.realScanRoot = await safeDirectory(scanRoot, assertTime); }
          catch (error) { if (missing(error)) throw failure('OUTPUT_ROOT_MISSING'); throw error; }
          conflicts(run); if (run.conflicted) return null;
          return scan(run, assertTime);
        });
        if (result) { run.realScanRoot = result.root; conflicts(run); if (!run.conflicted) run.baseline = result.files; }
      } catch (error) {
        if (error.code === 'OUTPUT_ROOT_MISSING') run.baseline = new Map();
        else warn(run, 'BASELINE_' + (error.code || 'READ_FAILED'));
      }
    }
    return snapshot(run.runId);
  }
  function observe({ runId, event } = {}) {
    const run = runs.get(runId);
    if (!run || run.status !== 'running' || !event || event.jobId && event.jobId !== runId) return;
    const eventOwner = owner(event);
    if (eventOwner === null) return;
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'assistant') for (const block of blocks) {
      if (block?.type !== 'tool_use' || !WRITE_TOOLS.has(block.name) || !boundedString(block.id)) continue;
      if (run.intents.has(block.id)) continue;
      if (run.intents.size >= cap.maxCandidates) { warn(run, 'TOOL_LIMIT'); continue; }
      const file = resolvePath(run, block.input?.file_path || block.input?.notebook_path || block.input?.path, event.cwd || run.cwd);
      if (file) run.intents.set(block.id, { id: block.id, path: file, owner: eventOwner, name: block.name, settled: false });
    }
    if (event.type === 'user') for (const block of blocks) {
      const intent = block?.type === 'tool_result' && run.intents.get(block.tool_use_id);
      if (!intent || intent.owner !== eventOwner || intent.settled) continue;
      if (block.is_error === true || event.is_error === true) { intent.settled = true; continue; }
      queueSuccess(run, intent);
    }
  }
  async function finish({ runId, finalText = '', status = 'complete' } = {}) {
    const run = runs.get(runId); if (!run) return null;
    if (run.finishPromise) { await run.finishPromise; return snapshot(runId); }
    run.status = 'finishing';
    run.finishPromise = (async () => {
      try {
        await bounded(cap.finishBudgetMs, async assertTime => {
          await run.pending; assertTime();
          if (run.scanRoot && run.baseline && !run.conflicted) {
            try {
              const result = await scan(run, assertTime); run.realScanRoot ||= result.root; conflicts(run);
              if (!run.conflicted) for (const [key, file] of result.files) {
                const old = run.baseline.get(key);
                if (!old || old.size !== file.size || old.mtimeMs !== file.mtimeMs || old.ino !== file.ino) {
                  const checked = await inspect(run, file.path, assertTime);
                  if (checked && !run.conflicted && !isProjectGuidance(checked.path)) {
                    if (run.candidates.size >= cap.maxCandidates && !run.candidates.has(key)) { warn(run, 'CANDIDATE_LIMIT'); break; }
                    if (!run.candidates.has(key)) run.candidates.set(key, { ...checked, toolUseId: null });
                    put(run, checked, 'output-delta');
                  }
                }
              }
            } catch (error) { if (!missing(error) && error.code !== 'OUTPUT_ROOT_MISSING') warn(run, 'OUTPUT_' + (error.code || 'READ_FAILED')); }
          }
          const references = finalReferences(finalText, run.cwd, cap.maxReferences);
          if (references.truncated) warn(run, 'FINAL_REFERENCE_LIMIT');
          for (const reference of references.entries) {
            assertTime(); let candidate;
            if (reference.basename) {
              const matches = [...run.candidates.values()].filter(file => sameBasename(path.basename(file.path), reference.basename));
              if (matches.length !== 1) continue; candidate = matches[0];
            } else candidate = run.candidates.get(locationKey(reference.path));
            const requested = candidate?.path || reference.path;
            const ext = path.extname(requested).slice(1).toLowerCase();
            if (!DELIVERY_EXTENSIONS.has(ext) && !(candidate && SCRIPT_EXTENSIONS.has(ext))
                && !(candidate && run.realScanRoot && isWithinLocation(candidate.path, run.realScanRoot))) continue;
            try {
              const file = await inspect(run, requested, assertTime);
              if (file) put(run, file, candidate?.toolUseId ? 'write-tool' : 'final-reference', candidate?.toolUseId || null);
            } catch (error) { if (!missing(error)) warn(run, 'REFERENCE_' + (error.code || 'READ_FAILED')); }
          }
        });
      } catch (error) { warn(run, 'FINISH_' + (error.code || 'FAILED')); }
      run.closed = true;
      run.status = ['complete', 'failed', 'canceled', 'interrupted'].includes(status) ? status : 'complete';
      run.intents.clear(); run.baseline = null; notify(run);
      return snapshot(runId);
    })();
    await run.finishPromise; return snapshot(runId);
  }
  function forget(runId) { const run = runs.get(runId); if (run) run.status = 'forgotten'; return runs.delete(runId); }
  return { begin, observe, finish, snapshot, forget };
}
module.exports = { createDeliveryRegistry, DEFAULT_LIMITS, finalReferences };
