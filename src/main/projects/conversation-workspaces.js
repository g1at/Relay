'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validConversationId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value);
}
function conversationFolder(conversationId) {
  if (!validConversationId(conversationId)) throw new Error('需要有效的对话标识才能打开工作目录');
  return UUID.test(conversationId) ? conversationId.toLowerCase()
    : 'conversation-' + crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 32);
}
function isDescendant(parent, child) {
  const relative = path.relative(parent, child);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function directoryValue(value) {
  return typeof value === 'string' ? value : value && typeof value.path === 'string' ? value.path : null;
}
function workspaceKey(value) {
  if (!value) return '';
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
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
  loadConversation = () => null, persistConversationRecord = () => {},
  getAgentProjectRoot = () => null, validateWorkspace = () => {},
  getBaseDir = () => null,
} = {}) {
  const defaultBase = path.join(homeDir, 'RelayProjects');
  const currentBase = () => getBaseDir() || defaultBase;
  // This location is independent of project membership and the default output
  // preference. Existing process files remain reachable after a project change.
  const scratchBase = scratchBaseDir || path.join(registryPath ? path.dirname(registryPath) : path.join(homeDir, '.relay'), 'conversation-scratch');
  function resolveScratch(conversationId) {
    const folder = conversationFolder(conversationId);
    if (!path.isAbsolute(scratchBase)) throw new Error('过程文件目录必须是绝对路径');
    const owner = path.dirname(scratchBase);
    fs.mkdirSync(owner, { recursive: true });
    fs.mkdirSync(scratchBase, { recursive: true });
    if (!isDescendant(fs.realpathSync(owner), fs.realpathSync(scratchBase))) throw new Error('过程文件目录不能链接到 Relay 数据目录之外');
    const scratchDir = path.join(scratchBase, folder);
    fs.mkdirSync(scratchDir, { recursive: true });
    const actualBase = fs.realpathSync(scratchBase), actualScratch = fs.realpathSync(scratchDir);
    if (!isDescendant(actualBase, actualScratch) || workspaceKey(actualScratch) !== workspaceKey(path.join(actualBase, folder))) {
      throw new Error('过程文件目录不能链接到其他会话或会话归档之外');
    }
    return directory(scratchDir);
  }
  let records = null;
  function readRecords() {
    if (records) return records;
    if (!registryPath || !fs.existsSync(registryPath)) { records = Object.create(null); return records; }
    const saved = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!saved || saved.version !== 1 || !saved.items || typeof saved.items !== 'object') throw new Error('工作目录索引格式无效');
    records = Object.create(null);
    for (const [id, item] of Object.entries(saved.items)) {
      if (validConversationId(id) && item && typeof item.cwd === 'string') records[id] = item;
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
  function resolveWorkspace({ conversationId, workingDir, agentName, mode } = {}) {
    if (!validConversationId(conversationId)) throw new Error('需要有效的对话标识才能打开工作目录');
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
      const base = previous && previous.managed && path.basename(previous.cwd) === folder
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
    const scratchDir = resolveScratch(conversationId);
    if (explicit && previous && previous.managed && workspaceKey(previous.cwd) === workspaceKey(cwd)) {
      managed = true; managedRoot = previous.managedRoot || path.dirname(cwd);
    }
    const legacyCwd = directoryValue(conversation && conversation.workingDir)
      || (conversation && conversation.mode === 'agent' ? agentProjectRoot : null) || homeDir;
    const previousCwd = previous && previous.cwd || legacyCwd;
    const changed = workspaceKey(previousCwd) !== workspaceKey(cwd);
    const rejected = new Set(Array.isArray(previous && previous.rejectedSessionIds) ? previous.rejectedSessionIds : []);
    const storedSession = conversation && conversation.sessionId;
    if (changed && storedSession) rejected.add(storedSession);
    const sessionInvalidated = !!(storedSession && rejected.has(storedSession));
    const needsContext = !!(previous && previous.needsContext) || !!(changed && conversation && Array.isArray(conversation.turns) && conversation.turns.length);
    const next = { cwd, managed, ...(managedRoot ? { managedRoot } : {}), needsContext, rejectedSessionIds: [...rejected].slice(-64) };
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      all[conversationId] = next;
      try { saveRecords(); } catch (error) { if (previous) all[conversationId] = previous; else delete all[conversationId]; throw error; }
    }
    if (sessionInvalidated) {
      // Preserve every history field and timestamp; only the unusable runtime handle changes.
      persistConversationRecord({ ...conversation, sessionId: null, carryContextOnNextTurn: 'workspace' });
    }
    return { root: cwd, cwd, validWorkingDir: cwd, agentProjectRoot, scratchDir,
      conversationId, managed, workspaceChanged: changed, sessionInvalidated,
      previousCwd, conversation, needsContext };
  }
  function invalidateConversationSession(conversationId, sessionId) {
    if (!validConversationId(conversationId)) throw new Error('对话标识无效');
    const rejectedId = typeof sessionId === 'string' && sessionId ? sessionId : null;
    const all = readRecords(), previous = all[conversationId];
    const rejected = new Set(Array.isArray(previous && previous.rejectedSessionIds) ? previous.rejectedSessionIds : []);
    if (previous && previous.needsContext && (!rejectedId || rejected.has(rejectedId))) return false;
    if (rejectedId) rejected.add(rejectedId);
    const conversation = loadConversation(conversationId);
    const legacyCwd = directoryValue(conversation && conversation.workingDir);
    // Record the old handle before project membership changes. This does not
    // create a workspace, touch history timestamps, or require an online folder.
    all[conversationId] = { ...(previous || {}),
      cwd: previous && previous.cwd || legacyCwd || homeDir,
      managed: previous ? previous.managed : !legacyCwd,
      needsContext: true, rejectedSessionIds: [...rejected].slice(-64) };
    try { saveRecords(); }
    catch (error) { if (previous) all[conversationId] = previous; else delete all[conversationId]; throw error; }
    return true;
  }
  function acceptsSession(conversationId, sessionId) {
    const item = readRecords()[conversationId];
    return !sessionId || !(item && Array.isArray(item.rejectedSessionIds) && item.rejectedSessionIds.includes(sessionId));
  }
  function markContextCarried(conversationId) {
    const item = readRecords()[conversationId];
    if (item && item.needsContext) {
      item.needsContext = false;
      try { saveRecords(); } catch (error) { item.needsContext = true; throw error; }
    }
    const conversation = loadConversation(conversationId);
    if (conversation && conversation.carryContextOnNextTurn === 'workspace') {
      const next = { ...conversation }; delete next.carryContextOnNextTurn;
      persistConversationRecord(next);
    }
  }
  return { resolveWorkspace, resolveScratch, invalidateConversationSession, acceptsSession, markContextCarried, get base() { return currentBase(); } };
}

module.exports = { createConversationWorkspaces, validConversationId, directoryValue, workspaceKey, conversationContext, UUID };
