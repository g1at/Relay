'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUPPORT_DIRS = new Set(['scripts', 'references', 'templates', 'assets']);
const MAX_FILES = 5000;
const MAX_PACKAGE_BYTES = 250 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

class SkillDraftError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'SkillDraftError';
    this.code = code;
    if (details != null) this.details = details;
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function randomToken() {
  return crypto.randomBytes(8).toString('hex');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomToken()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    // Windows does not consistently allow rename() to replace an existing file.
    if (!fs.existsSync(file)) throw error;
    const previous = `${file}.${process.pid}.${randomToken()}.old`;
    fs.renameSync(file, previous);
    try {
      fs.renameSync(temp, file);
      try { fs.rmSync(previous, { force: true }); } catch (_) {}
    } catch (replaceError) {
      try { if (!fs.existsSync(file)) fs.renameSync(previous, file); } catch (_) {}
      throw replaceError;
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
  }
}

function assertSafeId(value, label = 'id') {
  const id = String(value || '');
  if (!SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new SkillDraftError('INVALID_ID', `Invalid ${label}`);
  }
  return id;
}

function assertSafeSkillName(value) {
  const name = String(value || '');
  if (!SAFE_SKILL_NAME.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
    throw new SkillDraftError('INVALID_SKILL_NAME', 'Invalid skill name');
  }
  assertWindowsSafeSegment(name);
  return name;
}

function assertWindowsSafeSegment(segment) {
  const value = String(segment || '');
  if (!value || /[<>:"|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)) {
    throw new SkillDraftError('UNSAFE_PACKAGE_PATH', `Unsafe package path segment: ${value}`);
  }
  const base = value.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) {
    throw new SkillDraftError('UNSAFE_PACKAGE_PATH', `Windows reserved package path: ${value}`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(relativePath) {
  return String(relativePath).split(path.sep).join('/');
}

function sameManifest(left, right) {
  return !!left && !!right
    && !!left.exists === !!right.exists
    && (left.exists ? left.treeHash === right.treeHash : true);
}

function draftFingerprint(skillName, base, proposed) {
  return sha256(Buffer.from(JSON.stringify([skillName, base && base.exists ? base.treeHash : null, proposed && proposed.treeHash])));
}

// Merge package trees by file, treating delete/change and file/directory changes
// as conflicts. We deliberately do not guess how two different text edits fit.
function packageTree(root, manifest) {
  if (!manifest.exists) return null;
  const tree = { kind: 'directory', mode: null, children: new Map() };
  function parentFor(relative) {
    const parts = relative.split('/');
    const name = parts.pop();
    let parent = tree;
    for (const part of parts) parent = parent.children.get(part);
    return { parent, name };
  }
  for (const entry of [...manifest.directories].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const { parent, name } = parentFor(entry.path);
    parent.children.set(name, { kind: 'directory', mode: entry.mode, children: new Map() });
  }
  for (const entry of manifest.files) {
    const { parent, name } = parentFor(entry.path);
    parent.children.set(name, { kind: 'file', mode: entry.mode, sha256: entry.sha256, size: entry.size, source: path.join(root, ...entry.path.split('/')) });
  }
  return tree;
}

function sameNode(left, right) {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind || left.mode !== right.mode) return false;
  if (left.kind === 'file') return left.sha256 === right.sha256 && left.size === right.size;
  if (left.children.size !== right.children.size) return false;
  return [...left.children].every(([name, child]) => sameNode(child, right.children.get(name) || null));
}

function conflictText(node) {
  if (!node) return { text: null, binary: false };
  if (node.kind !== 'file' || node.size > 256 * 1024) return { text: null, binary: true };
  const buffer = fs.readFileSync(node.source);
  const text = buffer.toString('utf8');
  if (buffer.includes(0) || !Buffer.from(text, 'utf8').equals(buffer)) return { text: null, binary: true };
  return { text, binary: false };
}

function conflictVersion(node) {
  if (!node) return { exists: false, kind: null };
  return { exists: true, kind: node.kind, ...(node.kind === 'file' ? { size: node.size } : {}) };
}

function mergePackageTrees(base, current, proposed, resolutions = {}) {
  const conflicts = [];
  const usedResolutions = new Set();
  function conflict(relative, before, live, after, structural = false) {
    const views = [before, live, after].map(conflictText);
    const binary = views.some((view) => view.binary);
    const entry = {
      path: relative || '.', binary, structural,
      base: views[0].text, current: views[1].text, proposed: views[2].text,
      versions: { base: conflictVersion(before), current: conflictVersion(live), proposed: conflictVersion(after) },
    };
    if (!Object.prototype.hasOwnProperty.call(resolutions, entry.path)) {
      conflicts.push(entry);
      return live;
    }
    usedResolutions.add(entry.path);
    const resolution = resolutions[entry.path];
    if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) {
      throw new SkillDraftError('INVALID_RESOLUTION', 'A conflict resolution must select a version or provide text', { path: entry.path });
    }
    if (Object.prototype.hasOwnProperty.call(resolution, 'text')) {
      if (binary || structural || typeof resolution.text !== 'string' || 'choice' in resolution || Buffer.byteLength(resolution.text) > MAX_FILE_BYTES || resolution.text.includes('\0')) {
        throw new SkillDraftError('INVALID_RESOLUTION', 'This conflict cannot use the supplied text resolution', { path: entry.path });
      }
      const content = Buffer.from(resolution.text, 'utf8');
      return { kind: 'file', mode: (live || after || before).mode, content, size: content.length, sha256: sha256(content) };
    }
    if (!['base', 'current', 'proposed', 'delete'].includes(resolution.choice)) {
      throw new SkillDraftError('INVALID_RESOLUTION', 'Unknown conflict resolution choice', { path: entry.path });
    }
    return resolution.choice === 'base' ? before : resolution.choice === 'current' ? live : resolution.choice === 'proposed' ? after : null;
  }
  function visit(relative, before, live, after) {
    if (sameNode(live, after)) return live;
    if (sameNode(before, live)) return after;
    if (sameNode(before, after)) return live;
    if ([before, live, after].every((node) => !node || node.kind === 'directory')) {
      const liveMode = live ? live.mode : before && before.mode;
      const afterMode = after ? after.mode : before && before.mode;
      let mode;
      if (liveMode === afterMode) mode = liveMode;
      else if (before && before.mode === liveMode) mode = afterMode;
      else if (before && before.mode === afterMode) mode = liveMode;
      else return conflict(relative, before, live, after, true);
      const children = new Map();
      const names = new Set([...(before ? before.children.keys() : []), ...(live ? live.children.keys() : []), ...(after ? after.children.keys() : [])]);
      for (const name of [...names].sort()) {
        const child = visit(relative ? `${relative}/${name}` : name, before && before.children.get(name) || null, live && live.children.get(name) || null, after && after.children.get(name) || null);
        if (child) children.set(name, child);
      }
      if (!children.size && (!live || !after)) return null;
      return { kind: 'directory', mode, children };
    }
    return conflict(relative, before, live, after, [before, live, after].some((node) => node && node.kind === 'directory'));
  }
  const tree = visit('', base, current, proposed);
  for (const key of Object.keys(resolutions)) {
    if (!usedResolutions.has(key)) throw new SkillDraftError('INVALID_RESOLUTION', 'The supplied path is not a current conflict', { path: key });
  }
  return { tree, conflicts };
}

function writeMergedTree(root, tree) {
  if (!tree || tree.kind !== 'directory') throw new SkillDraftError('INVALID_RESOLUTION', 'A skill package must remain a directory');
  fs.mkdirSync(root, { recursive: false });
  let totalBytes = 0;
  let fileCount = 0;
  function visit(directory, node) {
    const foldedNames = new Set();
    for (const name of node.children.keys()) {
      const folded = name.toLocaleLowerCase('en-US');
      if (foldedNames.has(folded)) throw new SkillDraftError('CASE_COLLISION', `Merged package paths collide on Windows: ${name}`);
      foldedNames.add(folded);
    }
    for (const [name, child] of node.children) {
      assertWindowsSafeSegment(name);
      const target = path.join(directory, name);
      if (!isWithin(root, target)) throw new SkillDraftError('PATH_ESCAPE', 'Unsafe merged package path');
      if (child.kind === 'file') {
        totalBytes += child.size;
        fileCount += 1;
        if (child.size > MAX_FILE_BYTES || fileCount > MAX_FILES || totalBytes > MAX_PACKAGE_BYTES) {
          throw new SkillDraftError('PACKAGE_TOO_LARGE', 'Merged skill package exceeds the safe copy limit');
        }
      }
      if (child.kind === 'directory') {
        fs.mkdirSync(target, { mode: child.mode });
        visit(target, child);
      } else if (child.content) fs.writeFileSync(target, child.content, { flag: 'wx', mode: child.mode });
      else {
        const stat = fs.lstatSync(child.source);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new SkillDraftError('PACKAGE_CHANGED', 'Package changed during rebase');
        const buffer = fs.readFileSync(child.source);
        if (sha256(buffer) !== child.sha256) throw new SkillDraftError('PACKAGE_CHANGED', 'Package changed during rebase');
        fs.writeFileSync(target, buffer, { flag: 'wx', mode: child.mode });
      }
      try { fs.chmodSync(target, child.mode); } catch (_) {}
    }
  }
  visit(root, tree);
}

function missingManifest() {
  return {
    schemaVersion: 1,
    exists: false,
    treeHash: null,
    fileCount: 0,
    directoryCount: 0,
    totalBytes: 0,
    directories: [],
    files: [],
  };
}

function scanPackage(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  let rootStat;
  try { rootStat = fs.lstatSync(absoluteRoot); } catch (error) {
    if (error && error.code === 'ENOENT' && options.allowMissing) return missingManifest();
    if (error && error.code === 'ENOENT') {
      throw new SkillDraftError('PACKAGE_NOT_FOUND', 'Skill package directory does not exist');
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SkillDraftError('UNSAFE_PACKAGE_ROOT', 'Skill package root must be a real directory');
  }

  const files = [];
  const directories = [];
  const caseInsensitivePaths = new Map();
  let totalBytes = 0;

  function remember(relativePath) {
    const folded = relativePath.toLocaleLowerCase('en-US');
    const previous = caseInsensitivePaths.get(folded);
    if (previous && previous !== relativePath) {
      throw new SkillDraftError('CASE_COLLISION', `Package paths collide on Windows: ${previous}, ${relativePath}`);
    }
    caseInsensitivePaths.set(folded, relativePath);
  }

  function visit(directory, relativeDirectory = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      assertWindowsSafeSegment(entry.name);
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name);
      if (!isWithin(absoluteRoot, absolute)) {
        throw new SkillDraftError('PATH_ESCAPE', `Package path escapes its root: ${relative}`);
      }
      remember(relative);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new SkillDraftError('SYMLINK_NOT_ALLOWED', `Symbolic links are not allowed in skill packages: ${relative}`);
      }
      if (stat.isDirectory()) {
        directories.push({ path: relative, mode: stat.mode & 0o777 });
        visit(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new SkillDraftError('UNSUPPORTED_FILE_TYPE', `Unsupported file type in skill package: ${relative}`);
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw new SkillDraftError('PACKAGE_TOO_LARGE', `Skill package file is too large: ${relative}`);
      }
      totalBytes += stat.size;
      if (files.length >= MAX_FILES || totalBytes > MAX_PACKAGE_BYTES) {
        throw new SkillDraftError('PACKAGE_TOO_LARGE', 'Skill package exceeds the safe copy limit');
      }
      files.push({
        path: relative,
        size: stat.size,
        mode: stat.mode & 0o777,
        sha256: sha256(fs.readFileSync(absolute)),
      });
    }
  }

  visit(absoluteRoot);
  directories.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const tree = crypto.createHash('sha256');
  for (const directory of directories) {
    tree.update(`D\0${directory.path}\0${directory.mode}\n`, 'utf8');
  }
  for (const file of files) {
    tree.update(`F\0${file.path}\0${file.mode}\0${file.size}\0${file.sha256}\n`, 'utf8');
  }
  return {
    schemaVersion: 1,
    exists: true,
    treeHash: tree.digest('hex'),
    fileCount: files.length,
    directoryCount: directories.length,
    totalBytes,
    directories,
    files,
  };
}

function copyPackage(sourceRoot, destinationRoot, expectedManifest = null) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (fs.existsSync(destination)) {
    throw new SkillDraftError('DESTINATION_EXISTS', 'Safe package copy destination already exists');
  }
  const manifest = expectedManifest || scanPackage(source);
  if (!manifest.exists) throw new SkillDraftError('PACKAGE_NOT_FOUND', 'Cannot copy a missing package');
  fs.mkdirSync(destination, { recursive: false });
  try {
    for (const directory of manifest.directories) {
      const target = path.resolve(destination, ...directory.path.split('/'));
      if (!isWithin(destination, target)) throw new SkillDraftError('PATH_ESCAPE', 'Unsafe package directory');
      fs.mkdirSync(target, { recursive: true, mode: directory.mode });
      try { fs.chmodSync(target, directory.mode); } catch (_) {}
    }
    for (const file of manifest.files) {
      const sourceFile = path.resolve(source, ...file.path.split('/'));
      const targetFile = path.resolve(destination, ...file.path.split('/'));
      if (!isWithin(source, sourceFile) || !isWithin(destination, targetFile)) {
        throw new SkillDraftError('PATH_ESCAPE', 'Unsafe package file');
      }
      const sourceStat = fs.lstatSync(sourceFile);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new SkillDraftError('PACKAGE_CHANGED', `Package changed while copying: ${file.path}`);
      }
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(targetFile, file.mode); } catch (_) {}
    }
    const copied = scanPackage(destination);
    if (!sameManifest(manifest, copied)) {
      throw new SkillDraftError('PACKAGE_CHANGED', 'Package changed while it was being copied');
    }
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return clone(manifest);
}

function parseScalar(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    try { return JSON.parse(text); } catch (_) {
      throw new SkillDraftError('INVALID_FRONTMATTER', 'Invalid quoted YAML scalar');
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (/^(null|~)$/i.test(text)) return null;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  return text.replace(/\s+#.*$/, '').trim();
}

function parseSkillFrontmatter(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new SkillDraftError('INVALID_FRONTMATTER', 'SKILL.md must start with YAML frontmatter');
  }
  const close = normalized.indexOf('\n---\n', 4);
  if (close < 0) throw new SkillDraftError('INVALID_FRONTMATTER', 'SKILL.md frontmatter is not closed');
  const source = normalized.slice(4, close);
  const lines = source.split('\n');
  const fields = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line) || /^\s+/.test(line)) continue;
    if (/\t/.test(line)) throw new SkillDraftError('INVALID_FRONTMATTER', 'Tabs are not allowed in YAML frontmatter');
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/);
    if (!match) throw new SkillDraftError('INVALID_FRONTMATTER', `Invalid frontmatter line: ${line}`);
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new SkillDraftError('INVALID_FRONTMATTER', `Duplicate frontmatter field: ${key}`);
    }
    let rawValue = match[2] == null ? '' : match[2];
    if (/^[>|][+-]?$/.test(rawValue.trim())) {
      const folded = rawValue.trim().startsWith('>');
      const block = [];
      while (index + 1 < lines.length && (/^\s+/.test(lines[index + 1]) || !lines[index + 1].trim())) {
        index += 1;
        block.push(lines[index].replace(/^ {1,4}/, ''));
      }
      rawValue = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    }
    fields[key] = parseScalar(rawValue);
  }
  return {
    fields,
    body: normalized.slice(close + 5),
    raw: source,
  };
}

function validationIssue(code, message, file = null) {
  return { code, message, file };
}

function localMarkdownTargets(markdown) {
  const targets = new Set();
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(markdown))) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    else target = target.split(/\s+["']/)[0];
    targets.add(target);
  }
  const supportPattern = /(?:^|[\s`'"(])((?:scripts|references|templates|assets)\/[A-Za-z0-9_@%+.,\-/]+)/g;
  while ((match = supportPattern.exec(markdown))) targets.add(match[1].replace(/[.,;:]+$/, ''));
  return [...targets];
}

function validateLocalTarget(packageRoot, markdownFile, rawTarget) {
  let target = String(rawTarget || '').trim();
  if (!target || target.startsWith('#') || /^(?:https?:|mailto:|data:)/i.test(target)) return null;
  target = target.split('#')[0].split('?')[0];
  try { target = decodeURIComponent(target); } catch (_) {}
  if (!target) return null;
  if (path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) return null;
  const sourceDirectory = path.dirname(markdownFile);
  const resolved = path.resolve(sourceDirectory, target.replace(/\//g, path.sep));
  if (!isWithin(packageRoot, resolved)) {
    return validationIssue('REFERENCE_ESCAPE', `Reference escapes the skill package: ${rawTarget}`, toPosix(path.relative(packageRoot, markdownFile)));
  }
  if (!fs.existsSync(resolved)) {
    return validationIssue('BROKEN_REFERENCE', `Referenced package file does not exist: ${rawTarget}`, toPosix(path.relative(packageRoot, markdownFile)));
  }
  return null;
}

function validateDeclaredManifest(packageRoot, generatedManifest, errors) {
  const manifestFile = path.join(packageRoot, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (error) {
    errors.push(validationIssue('INVALID_MANIFEST', `manifest.json is not valid JSON: ${error.message}`, 'manifest.json'));
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(validationIssue('INVALID_MANIFEST', 'manifest.json must contain an object', 'manifest.json'));
    return null;
  }
  if (value.files != null && !Array.isArray(value.files)) {
    errors.push(validationIssue('INVALID_MANIFEST', 'manifest.json files must be an array', 'manifest.json'));
  }
  if (Array.isArray(value.files)) {
    const existing = new Set(generatedManifest.files.map((file) => file.path));
    for (const item of value.files) {
      const declared = typeof item === 'string' ? item : item && item.path;
      if (!declared || typeof declared !== 'string') {
        errors.push(validationIssue('INVALID_MANIFEST', 'manifest.json contains an invalid file entry', 'manifest.json'));
        continue;
      }
      const normalized = toPosix(path.posix.normalize(declared.replace(/\\/g, '/'))).replace(/^\.\//, '');
      if (normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
        errors.push(validationIssue('REFERENCE_ESCAPE', `manifest.json path escapes the package: ${declared}`, 'manifest.json'));
      } else if (!existing.has(normalized)) {
        errors.push(validationIssue('BROKEN_REFERENCE', `manifest.json lists a missing file: ${declared}`, 'manifest.json'));
      }
    }
  }
  return value;
}

function validateSkillPackage(packageRoot, options = {}) {
  const root = path.resolve(packageRoot);
  const errors = [];
  const warnings = [];
  let manifest;
  try { manifest = scanPackage(root); } catch (error) {
    return {
      ok: false,
      errors: [validationIssue(error.code || 'PACKAGE_INVALID', error.message)],
      warnings,
      frontmatter: null,
      manifest: null,
    };
  }
  const skillFile = path.join(root, 'SKILL.md');
  const skillEntry = manifest.files.find((file) => file.path === 'SKILL.md');
  if (!skillEntry) errors.push(validationIssue('SKILL_FILE_MISSING', 'Skill package must contain SKILL.md', 'SKILL.md'));

  let frontmatter = null;
  if (skillEntry) {
    let source = '';
    try { source = fs.readFileSync(skillFile, 'utf8'); } catch (error) {
      errors.push(validationIssue('SKILL_FILE_UNREADABLE', error.message, 'SKILL.md'));
    }
    if (source.includes('\uFFFD')) errors.push(validationIssue('INVALID_UTF8', 'SKILL.md is not valid UTF-8', 'SKILL.md'));
    try {
      const parsed = parseSkillFrontmatter(source);
      frontmatter = parsed.fields;
      const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
      const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
      if (!name || !SAFE_SKILL_NAME.test(name)) {
        errors.push(validationIssue('INVALID_SKILL_NAME', 'Frontmatter name is missing or invalid', 'SKILL.md'));
      }
      if (!description) errors.push(validationIssue('DESCRIPTION_MISSING', 'Frontmatter description is required', 'SKILL.md'));
      if (description.length > 2048) warnings.push(validationIssue('DESCRIPTION_LONG', 'Frontmatter description is unusually long', 'SKILL.md'));
      if (!parsed.body.trim()) warnings.push(validationIssue('SKILL_BODY_EMPTY', 'SKILL.md has no instruction body', 'SKILL.md'));
      if (options.skillName && name && name !== options.skillName) {
        errors.push(validationIssue('NAME_MISMATCH', `Frontmatter name (${name}) differs from package name (${options.skillName})`, 'SKILL.md'));
      }
    } catch (error) {
      errors.push(validationIssue(error.code || 'INVALID_FRONTMATTER', error.message, 'SKILL.md'));
    }
  }

  for (const directoryName of SUPPORT_DIRS) {
    const entry = path.join(root, directoryName);
    if (fs.existsSync(entry) && !fs.statSync(entry).isDirectory()) {
      errors.push(validationIssue('INVALID_SUPPORT_DIRECTORY', `${directoryName}/ must be a directory`, directoryName));
    }
  }

  for (const file of manifest.files.filter((item) => item.path.toLowerCase().endsWith('.md'))) {
    const markdownFile = path.resolve(root, ...file.path.split('/'));
    const markdown = fs.readFileSync(markdownFile, 'utf8');
    for (const target of localMarkdownTargets(markdown)) {
      const issue = validateLocalTarget(root, markdownFile, target);
      if (issue && !errors.some((candidate) => candidate.code === issue.code && candidate.message === issue.message && candidate.file === issue.file)) {
        errors.push(issue);
      }
    }
  }
  const declaredManifest = validateDeclaredManifest(root, manifest, errors);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    frontmatter,
    declaredManifest,
    manifest,
  };
}

function compareManifests(base, proposed) {
  const before = new Map((base && base.files || []).map((file) => [file.path, file]));
  const after = new Map((proposed && proposed.files || []).map((file) => [file.path, file]));
  const added = [];
  const removed = [];
  const modified = [];
  const modeChanged = [];
  for (const [filePath, file] of after) {
    const old = before.get(filePath);
    if (!old) added.push(filePath);
    else if (old.sha256 !== file.sha256 || old.size !== file.size) modified.push(filePath);
    else if (old.mode !== file.mode) modeChanged.push(filePath);
  }
  for (const filePath of before.keys()) if (!after.has(filePath)) removed.push(filePath);
  return {
    changed: !sameManifest(base, proposed),
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
    modeChanged: modeChanged.sort(),
  };
}

function unifiedTextDiff(oldText, newText, labels = {}) {
  const beforeText = String(oldText == null ? '' : oldText).replace(/\r\n?/g, '\n');
  const afterText = String(newText == null ? '' : newText).replace(/\r\n?/g, '\n');
  if (beforeText === afterText) return { changed: false, additions: 0, deletions: 0, text: '' };
  const before = beforeText ? beforeText.split('\n') : [];
  const after = afterText ? afterText.split('\n') : [];
  if (before.length && before[before.length - 1] === '') before.pop();
  if (after.length && after[after.length - 1] === '') after.pop();
  const operations = [];
  if (before.length * after.length <= 2_000_000) {
    const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
    for (let left = before.length - 1; left >= 0; left -= 1) {
      for (let right = after.length - 1; right >= 0; right -= 1) {
        table[left][right] = before[left] === after[right]
          ? table[left + 1][right + 1] + 1
          : Math.max(table[left + 1][right], table[left][right + 1]);
      }
    }
    let left = 0;
    let right = 0;
    while (left < before.length && right < after.length) {
      if (before[left] === after[right]) {
        operations.push([' ', before[left]]);
        left += 1;
        right += 1;
      } else if (table[left + 1][right] >= table[left][right + 1]) {
        operations.push(['-', before[left]]);
        left += 1;
      } else {
        operations.push(['+', after[right]]);
        right += 1;
      }
    }
    while (left < before.length) operations.push(['-', before[left++]]);
    while (right < after.length) operations.push(['+', after[right++]]);
  } else {
    for (const line of before) operations.push(['-', line]);
    for (const line of after) operations.push(['+', line]);
  }
  const additions = operations.filter(([type]) => type === '+').length;
  const deletions = operations.filter(([type]) => type === '-').length;
  const oldLabel = labels.oldLabel || 'live/SKILL.md';
  const newLabel = labels.newLabel || 'draft/SKILL.md';
  const text = [
    `--- ${oldLabel}`,
    `+++ ${newLabel}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...operations.map(([type, line]) => `${type}${line}`),
    '',
  ].join('\n');
  return { changed: true, additions, deletions, text };
}

class SkillDraftService {
  constructor(options = {}) {
    if (!options.skillsDir || !options.draftsDir) {
      throw new Error('SkillDraftService requires skillsDir and draftsDir');
    }
    this.skillsDir = path.resolve(options.skillsDir);
    this.draftsDir = path.resolve(options.draftsDir);
    this.draftRecordsDir = path.join(this.draftsDir, 'drafts');
    this.historyDir = path.join(this.draftsDir, 'history');
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => crypto.randomUUID();
    fs.mkdirSync(this.skillsDir, { recursive: true });
    fs.mkdirSync(this.draftRecordsDir, { recursive: true });
    fs.mkdirSync(this.historyDir, { recursive: true });
  }

  _at() { return this.now().toISOString(); }

  _newId(prefix, supplied = null) {
    return assertSafeId(supplied || `${prefix}_${this.idFactory()}`, `${prefix} id`);
  }

  _skillDir(skillName) {
    const name = assertSafeSkillName(skillName);
    const result = path.resolve(this.skillsDir, name);
    if (!isWithin(this.skillsDir, result) || result === this.skillsDir) throw new SkillDraftError('PATH_ESCAPE', 'Unsafe skill path');
    return result;
  }

  _draftDir(id) {
    const safeId = assertSafeId(id, 'draft id');
    const result = path.resolve(this.draftRecordsDir, safeId);
    if (!isWithin(this.draftRecordsDir, result) || result === this.draftRecordsDir) throw new SkillDraftError('PATH_ESCAPE', 'Unsafe draft path');
    return result;
  }

  _recordFile(id) { return path.join(this._draftDir(id), 'record.json'); }

  _readRecord(id) {
    try { return JSON.parse(fs.readFileSync(this._recordFile(id), 'utf8')); } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  _requireRecord(id) {
    const record = this._readRecord(id);
    if (!record) throw new SkillDraftError('DRAFT_NOT_FOUND', 'Skill draft does not exist');
    return record;
  }

  _writeRecord(record) {
    atomicWriteJson(this._recordFile(record.id), record);
    return clone(record);
  }

  _resolveStagingPackage(stagingDir, skillName) {
    const root = path.resolve(String(stagingDir || ''));
    if (!stagingDir) throw new SkillDraftError('STAGING_REQUIRED', 'A staging directory is required');
    if (fs.existsSync(path.join(root, 'SKILL.md'))) return root;
    const nested = path.join(root, skillName);
    if (fs.existsSync(path.join(nested, 'SKILL.md'))) return nested;
    return root;
  }

  createDraft(input = {}) {
    const skillName = assertSafeSkillName(input.skillName);
    const stagingPackage = this._resolveStagingPackage(input.stagingDir, skillName);
    // baseDir is the immutable library captured before generation, never the
    // generated staging tree. Missing nested packages mean a new skill.
    if (Object.prototype.hasOwnProperty.call(input, 'baseDir') && (!input.baseDir || typeof input.baseDir !== 'string')) {
      throw new SkillDraftError('BASE_REQUIRED', 'A valid generation baseline directory is required');
    }
    if (input.baseDir) {
      let stat;
      try { stat = fs.lstatSync(path.resolve(input.baseDir)); } catch (_) {}
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new SkillDraftError('BASE_REQUIRED', 'The generation baseline must be an existing real library directory');
    }
    const basePackage = input.baseDir ? path.join(path.resolve(input.baseDir), skillName) : this._skillDir(skillName);
    const proposed = scanPackage(stagingPackage);
    const base = scanPackage(basePackage, { allowMissing: true });
    if (sameManifest(base, proposed)) throw new SkillDraftError('NO_CHANGES', 'Staged skill package matches the live package');
    const fingerprint = draftFingerprint(skillName, base, proposed);
    const duplicate = this._listRecords({ status: 'draft', skillName }).find((record) => {
      if (!sameManifest(record.base, base) || !sameManifest(record.proposed, proposed)) return false;
      try {
        const stored = this._draftDir(record.id);
        return sameManifest(scanPackage(path.join(stored, 'base'), { allowMissing: true }), base)
          && sameManifest(scanPackage(path.join(stored, 'proposed')), proposed);
      } catch (_) { return false; }
    });
    if (duplicate) {
      this._addSource(duplicate, input);
      this._writeRecord(duplicate);
      return { ...this._viewRecord(duplicate), deduplicated: true };
    }

    const id = this._newId('draft', input.id);
    const finalDirectory = this._draftDir(id);
    if (fs.existsSync(finalDirectory)) throw new SkillDraftError('DRAFT_EXISTS', 'Skill draft already exists');

    const temporary = path.join(this.draftRecordsDir, `.creating-${id}-${randomToken()}`);
    fs.mkdirSync(temporary, { recursive: false });
    try {
      copyPackage(stagingPackage, path.join(temporary, 'proposed'), proposed);
      if (base.exists) copyPackage(basePackage, path.join(temporary, 'base'), base);
      const validation = validateSkillPackage(path.join(temporary, 'proposed'), { skillName });
      const at = this._at();
      const record = {
        schemaVersion: 1,
        id,
        skillName,
        status: 'draft',
        operation: base.exists ? 'update' : 'create',
        sourceRef: input.sourceRef == null ? null : clone(input.sourceRef),
        sources: [],
        sourceCount: 0,
        note: String(input.note || '').trim().slice(0, 1000),
        createdAt: at,
        updatedAt: at,
        base,
        proposed,
        fingerprint,
        changes: compareManifests(base, proposed),
        validation: {
          ok: validation.ok,
          errors: validation.errors,
          warnings: validation.warnings,
          frontmatter: validation.frontmatter,
        },
        published: null,
        rejection: null,
      };
      this._addSource(record, input);
      fs.writeFileSync(path.join(temporary, 'record.json'), JSON.stringify(record, null, 2), 'utf8');
      fs.renameSync(temporary, finalDirectory);
      return this._viewRecord(record);
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  _addSource(record, input) {
    if (!Array.isArray(record.sources)) {
      record.sources = [{ sourceRef: clone(record.sourceRef), note: record.note || '', at: record.createdAt, count: record.sourceCount || 1 }];
    }
    const sourceRef = input.sourceRef == null ? null : clone(input.sourceRef);
    const note = String(input.note || '').trim().slice(0, 1000);
    const previous = record.sources.find((source) => JSON.stringify(source.sourceRef) === JSON.stringify(sourceRef) && source.note === note);
    const at = this._at();
    if (previous) { previous.count = (previous.count || 1) + 1; previous.lastAt = at; }
    else record.sources.push({ sourceRef, note, at, count: 1 });
    record.sourceCount = record.sources.reduce((count, source) => count + (source.count || 1), 0);
    record.updatedAt = at;
  }

  _listRecords(filter = {}) {
    let entries = [];
    try { entries = fs.readdirSync(this.draftRecordsDir, { withFileTypes: true }); } catch (_) { return []; }
    return entries.filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => {
        try { return JSON.parse(fs.readFileSync(path.join(this.draftRecordsDir, entry.name, 'record.json'), 'utf8')); }
        catch (_) { return null; }
      })
      .filter((record) => record && SAFE_ID.test(record.id) && SAFE_SKILL_NAME.test(record.skillName))
      .filter((record) => !filter.status || record.status === filter.status)
      .filter((record) => !filter.skillName || record.skillName === filter.skillName)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map(clone);
  }

  listDrafts(filter = {}) {
    // A skill may have many archived candidates. Hash its live package once per
    // listing, while still checking each stored draft and every later request.
    const currentManifests = new Map();
    return this._listRecords(filter).map((record) => this._viewRecord(record, currentManifests));
  }

  getDraft(id) { const record = this._readRecord(id); return record ? this._viewRecord(record) : null; }

  diffDraft(id) {
    const record = this._requireRecord(id);
    const draftDirectory = this._draftDir(record.id);
    const baseRoot = path.join(draftDirectory, 'base');
    const proposedRoot = path.join(draftDirectory, 'proposed');
    const baseManifest = scanPackage(baseRoot, { allowMissing: true });
    const proposedManifest = scanPackage(proposedRoot);
    const changes = compareManifests(baseManifest, proposedManifest);
    const beforePaths = new Set(baseManifest.files.map((file) => file.path));
    const afterPaths = new Set(proposedManifest.files.map((file) => file.path));
    const changedPaths = [...new Set([
      ...(changes.added || []),
      ...(changes.modified || []),
      ...(changes.removed || []),
      ...(changes.modeChanged || []),
    ])].sort((left, right) => (
      left === 'SKILL.md' ? -1 : right === 'SKILL.md' ? 1 : left.localeCompare(right, 'en')
    ));
    const files = changedPaths.map((relativePath) => {
      const beforeFile = path.join(baseRoot, ...relativePath.split('/'));
      const afterFile = path.join(proposedRoot, ...relativePath.split('/'));
      const beforeExists = beforePaths.has(relativePath);
      const afterExists = afterPaths.has(relativePath);
      const beforeBuffer = beforeExists ? fs.readFileSync(beforeFile) : Buffer.alloc(0);
      const afterBuffer = afterExists ? fs.readFileSync(afterFile) : Buffer.alloc(0);
      const binary = beforeBuffer.includes(0) || afterBuffer.includes(0);
      if (binary || beforeBuffer.length > 256 * 1024 || afterBuffer.length > 256 * 1024) {
        return {
          path: relativePath,
          changed: true,
          binary: true,
          additions: 0,
          deletions: 0,
          text: `Binary files ${beforeExists ? `${record.skillName}/${relativePath}` : '/dev/null'} and ${afterExists ? `${record.skillName}/${relativePath} (draft)` : '/dev/null'} differ`,
        };
      }
      const diff = unifiedTextDiff(beforeBuffer.toString('utf8'), afterBuffer.toString('utf8'), {
        oldLabel: beforeExists ? `${record.skillName}/${relativePath}` : '/dev/null',
        newLabel: afterExists ? `${record.skillName}/${relativePath} (draft)` : '/dev/null',
      });
      if (!diff.changed && (changes.modeChanged || []).includes(relativePath)) {
        diff.changed = true;
        diff.text = `--- ${record.skillName}/${relativePath}\n+++ ${record.skillName}/${relativePath} (draft)\n# file mode changed`;
      }
      return { path: relativePath, binary: false, ...diff };
    });
    const additions = files.reduce((total, file) => total + (file.additions || 0), 0);
    const deletions = files.reduce((total, file) => total + (file.deletions || 0), 0);
    return {
      draftId: record.id,
      skillName: record.skillName,
      changed: files.some((file) => file.changed),
      additions,
      deletions,
      text: files.map((file) => file.text).filter(Boolean).join('\n\n'),
      files,
    };
  }

  _validateRecord(record) {
    const proposedRoot = path.join(this._draftDir(record.id), 'proposed');
    const validation = validateSkillPackage(proposedRoot, { skillName: record.skillName });
    if (!validation.manifest || !sameManifest(record.proposed, validation.manifest)) {
      validation.ok = false;
      validation.errors.unshift(validationIssue('DRAFT_PACKAGE_CHANGED', 'Draft package changed after it was created'));
    }
    try {
      const base = scanPackage(path.join(this._draftDir(record.id), 'base'), { allowMissing: true });
      if (!sameManifest(base, record.base)) throw new SkillDraftError('DRAFT_BASE_CHANGED', 'Stored generation baseline changed after the draft was created');
    } catch (error) {
      validation.ok = false;
      validation.errors.push(validationIssue(error.code || 'DRAFT_BASE_INVALID', error.message));
    }
    return clone(validation);
  }

  _readiness(record, currentManifests = null) {
    let validation;
    let current = null;
    try {
      validation = this._validateRecord(record);
      if (currentManifests && currentManifests.has(record.skillName)) {
        const cached = currentManifests.get(record.skillName);
        if (cached.error) throw cached.error;
        current = cached.manifest;
      } else {
        try {
          current = scanPackage(this._skillDir(record.skillName), { allowMissing: true });
          if (currentManifests) currentManifests.set(record.skillName, { manifest: current });
        } catch (error) {
          if (currentManifests) currentManifests.set(record.skillName, { error });
          throw error;
        }
      }
    } catch (error) {
      validation = validation || { ok: false, errors: [], warnings: [] };
      validation.ok = false;
      validation.errors.push(validationIssue(error.code || 'PACKAGE_UNREADABLE', error.message));
    }
    const baseMatches = sameManifest(current, record.base);
    const readiness = !validation.ok ? 'invalid' : sameManifest(current, record.proposed) ? 'already_applied' : baseMatches ? 'ready' : 'stale';
    return { validation, readiness, baseMatches, currentTreeHash: current && current.treeHash, canPublish: record.status === 'draft' && readiness === 'ready' };
  }

  _viewRecord(record, currentManifests = null) {
    const view = clone(record);
    if (!view.sourceCount) view.sourceCount = 1;
    if (!Array.isArray(view.sources)) view.sources = [{ sourceRef: clone(view.sourceRef), note: view.note || '', at: view.createdAt, count: view.sourceCount }];
    if (!view.fingerprint) view.fingerprint = draftFingerprint(view.skillName, view.base, view.proposed);
    return { ...view, ...this._readiness(record, currentManifests) };
  }

  validateDraft(id) {
    const { validation, ...readiness } = this._readiness(this._requireRecord(id));
    return { ...validation, ...readiness };
  }

  rebaseDraft(id, options = {}) {
    const record = this._requireRecord(id);
    if (record.status !== 'draft') throw new SkillDraftError('INVALID_DRAFT_STATE', 'Only pending drafts can be rebased');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new SkillDraftError('INVALID_RESOLUTION', 'Invalid rebase options');
    const hasResolutions = Object.prototype.hasOwnProperty.call(options, 'resolutions');
    const hasExpectation = Object.prototype.hasOwnProperty.call(options, 'expectedCurrentTreeHash');
    if (hasResolutions && !hasExpectation) throw new SkillDraftError('REBASE_EXPECTATION_REQUIRED', 'Conflict resolutions require the current tree hash shown during review');
    const resolutions = hasResolutions ? options.resolutions : {};
    if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions) || Object.keys(resolutions).length > MAX_FILES) {
      throw new SkillDraftError('INVALID_RESOLUTION', 'Invalid conflict resolutions');
    }
    const liveRoot = this._skillDir(record.skillName);
    const current = scanPackage(liveRoot, { allowMissing: true });
    const assertCurrent = () => {
      const actual = scanPackage(liveRoot, { allowMissing: true });
      if (!sameManifest(actual, current)) throw new SkillDraftError('REBASE_STALE', 'The live skill changed while this rebase was being reviewed', { currentTreeHash: actual.treeHash, expectedCurrentTreeHash: current.treeHash });
    };
    if (hasExpectation && options.expectedCurrentTreeHash !== current.treeHash) {
      throw new SkillDraftError('REBASE_STALE', 'The live skill changed since conflicts were shown', { currentTreeHash: current.treeHash, expectedCurrentTreeHash: options.expectedCurrentTreeHash });
    }
    const stored = this._draftDir(record.id);
    const baseRoot = path.join(stored, 'base');
    const proposedRoot = path.join(stored, 'proposed');
    const assertStored = () => {
      const base = scanPackage(baseRoot, { allowMissing: true });
      const proposed = scanPackage(proposedRoot);
      if (!sameManifest(base, record.base) || !sameManifest(proposed, record.proposed)) {
        throw new SkillDraftError('DRAFT_INVALID', 'Stored draft or generation baseline changed; rebase cannot use this package');
      }
      return { base, proposed };
    };
    const scannedDraft = assertStored();
    const temporary = path.join(this.draftRecordsDir, `.rebasing-${record.id}-${randomToken()}`);
    const baselineDir = path.join(temporary, 'baseline');
    const currentRoot = path.join(baselineDir, record.skillName);
    fs.mkdirSync(baselineDir, { recursive: true });
    try {
      if (current.exists) copyPackage(liveRoot, currentRoot, current);
      const currentTree = packageTree(currentRoot, current);
      const { tree, conflicts } = mergePackageTrees(
        // The hash is the recorded identity; file paths always come from the
        // fresh safe scan, never from an externally editable JSON file list.
        packageTree(baseRoot, scannedDraft.base), currentTree, packageTree(proposedRoot, scannedDraft.proposed), resolutions,
      );
      assertStored();
      assertCurrent();
      if (conflicts.length) throw new SkillDraftError('REBASE_CONFLICT', 'Review the files changed in both versions before creating a new draft', { draftId: record.id, currentTreeHash: current.treeHash, conflicts });

      if (sameNode(tree, currentTree)) {
        const at = this._at();
        record.status = 'merged';
        record.updatedAt = at;
        record.merged = { at, currentTreeHash: current.treeHash, reason: sameManifest(current, record.proposed) ? 'already-applied' : 'rebase-kept-current' };
        this._writeRecord(record);
        const previous = this._viewRecord(record);
        return { ok: true, draft: previous, previous, alreadyApplied: true };
      }

      const mergedRoot = path.join(temporary, 'proposed');
      writeMergedTree(mergedRoot, tree);
      // Scan before creating a candidate to reject structural/case collisions,
      // reserved paths, links, and oversized resolutions with the normal rules.
      scanPackage(mergedRoot);
      assertStored();
      assertCurrent();
      const candidate = this.createDraft({
        skillName: record.skillName,
        stagingDir: mergedRoot,
        baseDir: baselineDir,
        sourceRef: { type: 'rebase', draftId: record.id, sourceRef: clone(record.sourceRef) },
        note: record.note,
      });
      assertCurrent();
      // An unchanged baseline can deduplicate to this very candidate. It is
      // already reviewable and must never point to itself as superseded.
      if (candidate.id === record.id) return { ok: true, draft: candidate, previous: candidate, alreadyApplied: false };
      const next = this._requireRecord(candidate.id);
      next.rebasedFrom = [...new Set([...(Array.isArray(next.rebasedFrom) ? next.rebasedFrom : []), record.id])];
      this._writeRecord(next);
      const at = this._at();
      record.status = 'superseded';
      record.updatedAt = at;
      record.supersededBy = next.id;
      record.superseded = { at, draftId: next.id, currentTreeHash: current.treeHash };
      this._writeRecord(record);
      return { ok: true, draft: this._viewRecord(next), previous: this._viewRecord(record), alreadyApplied: false };
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  _historySkillDir(skillName) {
    const name = assertSafeSkillName(skillName);
    const result = path.resolve(this.historyDir, name);
    if (!isWithin(this.historyDir, result) || result === this.historyDir) throw new SkillDraftError('PATH_ESCAPE', 'Unsafe history path');
    return result;
  }

  _assertCallNameUnique(callName, ownSkillName) {
    const target = String(callName || '').trim().toLowerCase();
    if (!target) return;
    let entries = [];
    try { entries = fs.readdirSync(this.skillsDir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name.toLowerCase() === String(ownSkillName || '').toLowerCase()) continue;
      const file = path.join(this.skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
        const installed = String(parsed.fields && parsed.fields.name || '').trim().toLowerCase();
        if (installed === target) {
          throw new SkillDraftError(
            'SKILL_NAME_CONFLICT',
            `Skill call name conflicts with installed package: ${entry.name}`,
          );
        }
      } catch (error) {
        if (error instanceof SkillDraftError && error.code === 'SKILL_NAME_CONFLICT') throw error;
        // Existing malformed third-party skills remain inspectable; they do not reserve a call name.
      }
    }
  }

  _captureHistory(skillName, input = {}) {
    const id = this._newId('version', input.id);
    const skillDirectory = this._skillDir(skillName);
    const snapshot = scanPackage(skillDirectory, { allowMissing: true });
    if (input.expectedManifest && !sameManifest(snapshot, input.expectedManifest)) {
      throw new SkillDraftError('BASE_CONFLICT', 'Live skill changed before its history snapshot could be saved');
    }
    const parent = this._historySkillDir(skillName);
    fs.mkdirSync(parent, { recursive: true });
    const target = path.join(parent, id);
    if (fs.existsSync(target)) throw new SkillDraftError('HISTORY_EXISTS', 'Skill history version already exists');
    const temporary = path.join(parent, `.capturing-${id}-${randomToken()}`);
    fs.mkdirSync(temporary, { recursive: false });
    try {
      if (snapshot.exists) copyPackage(skillDirectory, path.join(temporary, 'package'), snapshot);
      const metadata = {
        schemaVersion: 1,
        id,
        skillName,
        capturedAt: this._at(),
        reason: input.reason || 'manual',
        draftId: input.draftId || null,
        snapshot,
        replacedBy: null,
        rollback: null,
      };
      fs.writeFileSync(path.join(temporary, 'version.json'), JSON.stringify(metadata, null, 2), 'utf8');
      fs.renameSync(temporary, target);
      return metadata;
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  _historyFile(skillName, versionId) {
    const id = assertSafeId(versionId, 'version id');
    return path.join(this._historySkillDir(skillName), id, 'version.json');
  }

  _readHistory(skillName, versionId) {
    try { return JSON.parse(fs.readFileSync(this._historyFile(skillName, versionId), 'utf8')); } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  _writeHistory(metadata) {
    atomicWriteJson(this._historyFile(metadata.skillName, metadata.id), metadata);
    return clone(metadata);
  }

  listHistory(skillName) {
    const directory = this._historySkillDir(skillName);
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return []; }
    return entries.filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => {
        try { return JSON.parse(fs.readFileSync(path.join(directory, entry.name, 'version.json'), 'utf8')); }
        catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))
      .map(clone);
  }

  getHistory(skillName, versionId) { return clone(this._readHistory(skillName, versionId)); }

  _replaceLive(skillName, sourcePackage, sourceManifest, expectedCurrentManifest = null) {
    const live = this._skillDir(skillName);
    const parent = this.skillsDir;
    const prepared = path.join(parent, `.relay-next-${skillName}-${randomToken()}`);
    const previous = path.join(parent, `.relay-previous-${skillName}-${randomToken()}`);
    copyPackage(sourcePackage, prepared, sourceManifest);
    const currentBeforeSwap = scanPackage(live, { allowMissing: true });
    if (expectedCurrentManifest && !sameManifest(currentBeforeSwap, expectedCurrentManifest)) {
      fs.rmSync(prepared, { recursive: true, force: true });
      throw new SkillDraftError('BASE_CONFLICT', 'Live skill changed immediately before replacement');
    }
    const hadLive = currentBeforeSwap.exists;
    try {
      if (hadLive) fs.renameSync(live, previous);
      try {
        fs.renameSync(prepared, live);
      } catch (error) {
        if (hadLive && !fs.existsSync(live)) fs.renameSync(previous, live);
        throw error;
      }
      try { fs.rmSync(previous, { recursive: true, force: true }); } catch (_) {}
    } finally {
      fs.rmSync(prepared, { recursive: true, force: true });
      if (fs.existsSync(previous) && !fs.existsSync(live)) {
        try { fs.renameSync(previous, live); } catch (_) {}
      }
    }
    const current = scanPackage(live);
    if (!sameManifest(current, sourceManifest)) {
      throw new SkillDraftError('PUBLISH_VERIFY_FAILED', 'Published skill package did not match the draft');
    }
    return current;
  }

  _removeLive(skillName, expectedCurrentManifest = null) {
    const live = this._skillDir(skillName);
    const current = scanPackage(live, { allowMissing: true });
    if (expectedCurrentManifest && !sameManifest(current, expectedCurrentManifest)) {
      throw new SkillDraftError('ROLLBACK_CONFLICT', 'Live skill changed immediately before removal');
    }
    if (!current.exists) return missingManifest();
    const removed = path.join(this.skillsDir, `.relay-removed-${skillName}-${randomToken()}`);
    fs.renameSync(live, removed);
    try { fs.rmSync(removed, { recursive: true, force: true }); } catch (_) {}
    return scanPackage(live, { allowMissing: true });
  }

  publishDraft(id) {
    const record = this._requireRecord(id);
    if (record.status !== 'draft') {
      throw new SkillDraftError('INVALID_DRAFT_STATE', 'Only pending drafts can be published');
    }
    const liveManifest = scanPackage(this._skillDir(record.skillName), { allowMissing: true });
    if (!sameManifest(liveManifest, record.base)) {
      throw new SkillDraftError('BASE_CONFLICT', 'The live skill changed after this draft was created', {
        expected: record.base.treeHash,
        actual: liveManifest.treeHash,
      });
    }
    const validation = this.validateDraft(record.id);
    if (!validation.ok) {
      throw new SkillDraftError('DRAFT_INVALID', 'The skill draft did not pass static validation', validation.errors);
    }
    this._assertCallNameUnique(
      validation.frontmatter && validation.frontmatter.name,
      record.skillName,
    );
    const history = this._captureHistory(record.skillName, {
      expectedManifest: record.base,
      reason: 'publish-preimage',
      draftId: record.id,
    });
    const publishedManifest = this._replaceLive(
      record.skillName,
      path.join(this._draftDir(record.id), 'proposed'),
      record.proposed,
      record.base,
    );
    history.replacedBy = { exists: true, treeHash: publishedManifest.treeHash };
    history.replacedAt = this._at();
    this._writeHistory(history);
    record.status = 'published';
    record.updatedAt = history.replacedAt;
    record.published = {
      at: history.replacedAt,
      historyVersionId: history.id,
      treeHash: publishedManifest.treeHash,
    };
    this._writeRecord(record);
    return { draft: this._viewRecord(record), history: clone(history) };
  }

  rejectDraft(id, reason = '') {
    const record = this._requireRecord(id);
    if (record.status !== 'draft') {
      throw new SkillDraftError('INVALID_DRAFT_STATE', 'Only pending drafts can be rejected');
    }
    const at = this._at();
    record.status = 'rejected';
    record.updatedAt = at;
    record.rejection = { at, reason: String(reason || '').trim().slice(0, 1000) };
    this._writeRecord(record);
    return this._viewRecord(record);
  }

  rollback(skillName, versionId, options = {}) {
    const name = assertSafeSkillName(skillName);
    const version = this._readHistory(name, versionId);
    if (!version) throw new SkillDraftError('HISTORY_NOT_FOUND', 'Skill history version does not exist');
    const current = scanPackage(this._skillDir(name), { allowMissing: true });
    let expected;
    if (Object.prototype.hasOwnProperty.call(options, 'expectedCurrentTreeHash')) {
      expected = { exists: options.expectedCurrentTreeHash != null, treeHash: options.expectedCurrentTreeHash || null };
    } else if (version.replacedBy) {
      expected = version.replacedBy;
    } else {
      throw new SkillDraftError('ROLLBACK_EXPECTATION_REQUIRED', 'This history version has no known replacement state');
    }
    if (!sameManifest(current, expected)) {
      throw new SkillDraftError('ROLLBACK_CONFLICT', 'The live skill no longer matches the version being rolled back', {
        expected: expected.treeHash,
        actual: current.treeHash,
      });
    }

    const backup = this._captureHistory(name, {
      expectedManifest: current,
      reason: 'rollback-preimage',
    });
    let restored;
    if (version.snapshot.exists) {
      const packageRoot = path.join(this._historySkillDir(name), version.id, 'package');
      const stored = scanPackage(packageRoot);
      if (!sameManifest(stored, version.snapshot)) {
        throw new SkillDraftError('HISTORY_CORRUPT', 'Stored skill history package does not match its manifest');
      }
      restored = this._replaceLive(name, packageRoot, version.snapshot, current);
    } else {
      restored = this._removeLive(name, current);
    }
    const at = this._at();
    backup.replacedBy = { exists: restored.exists, treeHash: restored.treeHash };
    backup.replacedAt = at;
    this._writeHistory(backup);
    version.rollback = {
      at,
      backupVersionId: backup.id,
      restoredTreeHash: restored.treeHash,
      restoredExists: restored.exists,
    };
    this._writeHistory(version);
    return {
      ok: true,
      skillName: name,
      restored: clone(restored),
      sourceVersionId: version.id,
      backupVersionId: backup.id,
    };
  }

  // Short aliases make IPC wiring concise while the explicit methods remain self-documenting.
  list(filter) { return this.listDrafts(filter); }
  get(id) { return this.getDraft(id); }
  diff(id) { return this.diffDraft(id); }
  validate(id) { return this.validateDraft(id); }
  publish(id) { return this.publishDraft(id); }
  reject(id, reason) { return this.rejectDraft(id, reason); }
  rebase(id, options) { return this.rebaseDraft(id, options); }
}

module.exports = {
  SkillDraftService,
  SkillDraftError,
  scanPackage,
  compareManifests,
  parseSkillFrontmatter,
  validateSkillPackage,
  unifiedTextDiff,
  sameManifest,
};
