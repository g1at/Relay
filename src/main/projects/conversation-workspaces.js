'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createConversationScratch, scratchRecord } = require('./conversation-scratch');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validConversationId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value);
}
function normalizeConversationId(value) { return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : value; }
function conversationFolder(conversationId) {
  if (!validConversationId(conversationId)) throw new Error('需要有效的对话标识才能打开工作目录');
  return UUID.test(conversationId) ? conversationId.toLowerCase()
    : 'conversation-' + crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 32);
}
function directoryValue(value) {
  return typeof value === 'string' ? value : value && typeof value.path === 'string' ? value.path : null;
}
function workspaceKey(value) {
  if (!value) return '';
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function allocatedManagedWorkspace(item, conversationId) {
  return !!(item?.managed && item.cwd && path.basename(item.cwd) === conversationFolder(conversationId)
    && (!item.managedRoot || workspaceKey(path.dirname(item.cwd)) === workspaceKey(item.managedRoot)));
}
function directory(value) {
  if (!path.isAbsolute(value)) throw new Error('工作目录必须是绝对路径');
  const root = path.resolve(value);
  let stat;
  try { stat = fs.statSync(root); } catch (_) { throw new Error('工作目录不存在或无法访问'); }
  if (!stat.isDirectory()) throw new Error('工作目录不是文件夹');
  fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
  return root;
}
const { build: conversationContext } = require('../../../renderer/conversation-context');

// The registry is independent of renderer history snapshots: a late history.save cannot
// re-authorize a session tied to an obsolete cwd or refresh sidebar activity timestamps.
function createConversationWorkspaces({
  homeDir = os.homedir(), registryPath = null, scratchBaseDir = null,
  loadConversation = () => null, loadConversationForCleanup = loadConversation, persistConversationRecord = () => {},
  getAgentProjectRoot = () => null, validateWorkspace = () => {},
  getBaseDir = () => null, getScratchBaseDir = () => null, assertConversationAvailable = () => {},
} = {}) {
  const defaultBase = path.join(homeDir, 'RelayProjects');
  const currentBase = () => getBaseDir() || defaultBase;
  const legacyScratchBase = scratchBaseDir || path.join(registryPath ? path.dirname(registryPath) : path.join(homeDir, '.relay'), 'conversation-scratch');
  let records = null;
  function readRecords() {
    if (records) return records;
    if (!registryPath || !fs.existsSync(registryPath)) { records = Object.create(null); return records; }
    const saved = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!saved || saved.version !== 1 || !saved.items || typeof saved.items !== 'object') throw new Error('工作目录索引格式无效');
    records = Object.create(null);
    for (const [id, item] of Object.entries(saved.items)) {
      if (validConversationId(id) && item && (typeof item.cwd === 'string' || typeof item.scratchDir === 'string')) {
        const normalized = normalizeConversationId(id);
        if (records[normalized] && JSON.stringify(records[normalized]) !== JSON.stringify(item)) { records = null; throw new Error('重复会话工作目录索引存在冲突'); }
        records[normalized] = item;
      }
    }
    return records;
  }
  function saveRecords() {
    if (!registryPath) return;
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const temp = registryPath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, items: records }, null, 2), 'utf8');
    fs.renameSync(temp, registryPath);
  }
  const scratch = createConversationScratch({ legacyRoot: legacyScratchBase, getRoot: getScratchBaseDir,
    folderFor: conversationFolder, readRecords, saveRecords, loadConversation, loadConversationForCleanup });
  const resolveScratch = (conversationId) => { conversationId = normalizeConversationId(conversationId); assertConversationAvailable(conversationId); return scratch.resolve(conversationId); };
  function resolveWorkspace({ conversationId, workingDir, agentName, mode, projectId } = {}) {
    conversationId = normalizeConversationId(conversationId);
    if (!validConversationId(conversationId)) throw new Error('需要有效的对话标识才能打开工作目录');
    assertConversationAvailable(conversationId);
    const conversation = loadConversation(conversationId);
    const all = readRecords(), previous = all[conversationId];
    const explicit = directoryValue(workingDir === undefined ? conversation && conversation.workingDir : workingDir);
    const effectiveMode = mode || conversation && conversation.mode || 'plain';
    const effectiveAgent = agentName || conversation && conversation.agent || null;
    let agentProjectRoot = null;
    if (effectiveMode === 'agent' && effectiveAgent) {
      const configured = getAgentProjectRoot(effectiveAgent);
      if (configured) { try { agentProjectRoot = directory(configured); } catch (_) {} }
    }
    let cwd, managed = !explicit;
    let managedRoot = null;
    if (explicit) cwd = directory(explicit);
    else {
      // Prefix/hash non-UUID legacy identifiers to avoid Windows reserved names/collisions.
      const folder = conversationFolder(conversationId);
      // A preference change applies only to new conversations. Keep an already
      // allocated archive in its original root, including after a restart.
      const base = allocatedManagedWorkspace(previous, conversationId)
        ? (previous.managedRoot || path.dirname(previous.cwd)) : currentBase();
      if (!path.isAbsolute(base)) throw new Error('默认工作目录必须是绝对路径');
      cwd = path.join(base, folder);
      managedRoot = base;
      fs.mkdirSync(cwd, { recursive: true });
      const realBase = fs.realpathSync(base), realRoot = fs.realpathSync(cwd);
      const relative = path.relative(realBase, realRoot);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('默认工作目录不能链接到归档目录之外');
      }
      cwd = directory(cwd);
    }
    validateWorkspace({ conversationId, cwd });
    const scratchDir = scratch.resolve(conversationId, cwd);
    if (explicit && allocatedManagedWorkspace(previous, conversationId) && workspaceKey(previous.cwd) === workspaceKey(cwd)) {
      managed = true; managedRoot = previous.managedRoot || path.dirname(cwd);
    }
    // Only managed, projectless workspaces get a dedicated delivery folder.
    // Existing project layouts and old files stay in place.
    // A native fork may reuse another managed workspace without owning its
    // allocation. It keeps the same outputs while receiving its own scratch.
    const sharedOwner = !managed && Object.entries(all).find(([ownerId, item]) => item.cwd
      && workspaceKey(item.cwd) === workspaceKey(cwd)
      && (allocatedManagedWorkspace(item, ownerId)
        || item.outputDir && workspaceKey(item.outputDir) === workspaceKey(path.join(cwd, 'outputs'))));
    const outputDir = managed || sharedOwner ? path.join(cwd, 'outputs') : cwd;
    const dedicatedOutput = workspaceKey(outputDir) !== workspaceKey(cwd);
    const within = (child, parent) => {
      const relative = path.relative(parent, child);
      return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    const realScratch = fs.realpathSync(scratchDir);
    if (within(outputDir, scratchDir) || dedicatedOutput && within(scratchDir, outputDir)) {
      throw new Error('成果目录不能与过程文件目录重合');
    }
    if (dedicatedOutput) {
      let stat;
      try { stat = fs.lstatSync(outputDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('成果目录必须是工作区内的真实文件夹');
      fs.mkdirSync(outputDir, { recursive: true });
      if (workspaceKey(fs.realpathSync(outputDir)) !== workspaceKey(path.join(fs.realpathSync(cwd), 'outputs'))) {
        throw new Error('成果目录不能链接到工作区之外');
      }
    }
    const realOutput = fs.realpathSync(outputDir);
    if (within(realOutput, realScratch) || dedicatedOutput && within(realScratch, realOutput)) {
      throw new Error('成果目录不能与过程文件目录重合');
    }
    const legacyCwd = directoryValue(conversation && conversation.workingDir)
      || (conversation && conversation.mode === 'agent' ? agentProjectRoot : null) || homeDir;
    const previousCwd = previous && previous.cwd || legacyCwd;
    const changed = workspaceKey(previousCwd) !== workspaceKey(cwd);
    const rejected = new Set(Array.isArray(previous && previous.rejectedSessionIds) ? previous.rejectedSessionIds : []);
    const storedSession = conversation && conversation.sessionId;
    if (changed && storedSession) rejected.add(storedSession);
    const sessionInvalidated = !!(storedSession && rejected.has(storedSession));
    const needsContext = !!(previous && previous.needsContext) || conversation?.carryContextOnNextTurn === 'workspace'
      || !!(changed && conversation && Array.isArray(conversation.turns) && conversation.turns.length);
    // Pin the small browsing scope only after the full allocation/ownership checks.
    // Browsing must not re-run task initialization or parse its whole transcript.
    const browseScope = projectId === null || typeof projectId === 'string'
      ? { projectId, cwd, realCwd: fs.realpathSync(cwd), outputDir, realOutput } : null;
    const next = { cwd, managed, outputDir, ...(managedRoot ? { managedRoot } : {}), needsContext, rejectedSessionIds: [...rejected].slice(-64),
      ...(browseScope ? { browseScope } : {}), ...scratchRecord(all[conversationId]) };
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      const beforeSave = all[conversationId];
      all[conversationId] = next;
      try { saveRecords(); } catch (error) { if (beforeSave) all[conversationId] = beforeSave; else delete all[conversationId]; throw error; }
    }
    if (sessionInvalidated) {
      // Preserve every history field and timestamp; only the unusable runtime handle changes.
      persistConversationRecord({ ...conversation, sessionId: null, carryContextOnNextTurn: 'workspace' });
    }
    return { root: cwd, cwd, validWorkingDir: cwd, agentProjectRoot, scratchDir, outputDir,
      conversationId, managed, workspaceChanged: changed, sessionInvalidated,
      previousCwd, conversation, needsContext };
  }
  function resolveBrowseWorkspace({ conversationId, projectId, projectDirectory = null } = {}) {
    const id = normalizeConversationId(conversationId);
    if (!validConversationId(id)) throw new Error('需要有效的对话标识才能打开工作目录');
    assertConversationAvailable(id);
    const item = readRecords()[id], scope = item?.browseScope;
    // Old/incomplete registrations get one normal resolution before this fast path.
    // The project binding comes from the main-process registry, never the renderer.
    if (!scope || scope.projectId !== projectId || scope.cwd !== item.cwd || scope.outputDir !== item.outputDir
      || !item.scratchRoot || !item.scratchDir || !item.scratchRootReal) return null;
    if (projectDirectory && workspaceKey(projectDirectory) !== workspaceKey(item.cwd)) return null;
    if (item.scratchMigration) throw new Error('过程文件迁移尚未完成，请稍后重试');
    function checkedDirectory(value, expected, label, forbidLink = false) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || typeof expected !== 'string' || !path.isAbsolute(expected)) throw new Error(label + '登记无效');
      const stat = fs.lstatSync(value);
      if (forbidLink && stat.isSymbolicLink()) throw new Error(label + '不能是链接');
      if (!fs.statSync(value).isDirectory()) throw new Error(label + '不是文件夹');
      const actual = fs.realpathSync(value);
      if (workspaceKey(actual) !== workspaceKey(expected)) throw new Error(label + '位置已改变，请重新确认工作目录');
      return actual;
    }
    const realCwd = checkedDirectory(item.cwd, scope.realCwd, '工作目录', !!item.managed);
    if (item.managed && !allocatedManagedWorkspace(item, id)) throw new Error('工作目录登记不属于此会话');
    const dedicatedOutput = workspaceKey(item.outputDir) !== workspaceKey(item.cwd);
    const realOutput = checkedDirectory(item.outputDir, scope.realOutput, '成果目录', dedicatedOutput);
    if (dedicatedOutput && (workspaceKey(item.outputDir) !== workspaceKey(path.join(item.cwd, 'outputs'))
      || workspaceKey(realOutput) !== workspaceKey(path.join(realCwd, 'outputs')))) throw new Error('成果目录已离开工作区');
    // The scratch root's ownership and canonical parent are pinned by allocation
    // or migration. Read-only browsing checks this one owner, not every registry
    // entry and every conversation body. Cleanup still uses the full preflight.
    if (workspaceKey(item.scratchDir) !== workspaceKey(path.join(item.scratchRoot, conversationFolder(id)))) throw new Error('过程文件登记不属于此会话');
    const scratchRoot = checkedDirectory(item.scratchRoot, item.scratchRootReal, '过程文件根目录', true);
    checkedDirectory(item.scratchDir, path.join(scratchRoot, conversationFolder(id)), '过程文件目录', true);
    return { root: item.cwd, cwd: item.cwd, conversationId: id, managed: !!item.managed,
      scratchDir: item.scratchDir, outputDir: item.outputDir, projectId };
  }
  function invalidateConversationSession(conversationId, sessionId) {
    conversationId = normalizeConversationId(conversationId);
    if (!validConversationId(conversationId)) throw new Error('对话标识无效');
    const rejectedId = typeof sessionId === 'string' && sessionId ? sessionId : null;
    const all = readRecords(), previous = all[conversationId];
    const rejected = new Set(Array.isArray(previous && previous.rejectedSessionIds) ? previous.rejectedSessionIds : []);
    if (previous && previous.needsContext && !previous.browseScope && (!rejectedId || rejected.has(rejectedId))) return false;
    if (rejectedId) rejected.add(rejectedId);
    const conversation = loadConversation(conversationId);
    const legacyCwd = directoryValue(conversation && conversation.workingDir);
    // Record the old handle before project membership changes. This does not
    // create a workspace, touch history timestamps, or require an online folder.
    all[conversationId] = { ...(previous || {}),
      cwd: previous && previous.cwd || legacyCwd || homeDir,
      managed: previous && typeof previous.managed === 'boolean' ? previous.managed : !legacyCwd,
      needsContext: true, rejectedSessionIds: [...rejected].slice(-64) };
    delete all[conversationId].browseScope;
    try { saveRecords(); }
    catch (error) { if (previous) all[conversationId] = previous; else delete all[conversationId]; throw error; }
    return true;
  }
  function acceptsSession(conversationId, sessionId) {
    conversationId = normalizeConversationId(conversationId);
    const item = readRecords()[conversationId];
    return !sessionId || !(item && Array.isArray(item.rejectedSessionIds) && item.rejectedSessionIds.includes(sessionId));
  }
  function markContextCarried(conversationId) {
    conversationId = normalizeConversationId(conversationId);
    const item = readRecords()[conversationId];
    // Admission mirrors legacy history markers into this registry. Most root
    // assistant frames have no pending carry, so never load their full history.
    if (!item?.needsContext) return false;
    const conversation = loadConversation(conversationId);
    // The history loader also returns null on transient I/O/parse failure.
    // Do not acknowledge a carry whose persisted marker could not be checked.
    if (!conversation) return false;
    if (conversation && conversation.carryContextOnNextTurn === 'workspace') {
      const next = { ...conversation }; delete next.carryContextOnNextTurn;
      if (persistConversationRecord(next) === false) return false;
    }
    // Commit history first: a failed write must leave the carry retryable.
    item.needsContext = false;
    try { saveRecords(); } catch (error) { item.needsContext = true; throw error; }
    return true;
  }
  function fileLocation(conversationId, item) {
    return {
      conversationId, cwd: item.cwd, managed: !!item.managed,
      outputDir: item.outputDir || null, scratchDir: item.scratchDir || null,
      previousScratchDirs: (item.scratchPrevious || []).map(location => location.dir),
    };
  }
  function listFileLocations() {
    return Object.entries(readRecords()).map(([conversationId, item]) => fileLocation(conversationId, item));
  }
  function fileLocations(conversationId) {
    const id = normalizeConversationId(conversationId), item = readRecords()[id];
    return item ? fileLocation(id, item) : null;
  }
  return { resolveWorkspace, resolveBrowseWorkspace, resolveScratch, fileLocations, listFileLocations,
    removeScratch: scratch.remove, removeForHistoryDeletion: scratch.removeForHistoryDeletion, migrateScratch: scratch.migrate, listScratch: scratch.list,
    invalidateConversationSession, acceptsSession, markContextCarried,
    get base() { return currentBase(); }, get scratchBase() { return scratch.base; } };
}

module.exports = { createConversationWorkspaces, validConversationId, directoryValue, workspaceKey, conversationContext, UUID };
