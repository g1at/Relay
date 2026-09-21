'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, createIcon } = require('../renderer/workspace-file-types');
const highlight = require('../renderer/vendor/highlight.min.js');

test('common deliverable types receive distinct semantic categories across Windows and POSIX paths', () => {
  const cases = {
    'C:\\RelayProjects\\demo\\APP.JS': 'javascript', '/app/src/main.ts': 'typescript', 'src/view.tsx': 'react',
    'src/view.jsx': 'react', 'script.py': 'python', '.zshrc': 'shell', 'run.ps1': 'shell', 'main.rs': 'code',
    'README.md': 'markdown', 'package.json': 'config', 'index.HTML': 'html', 'app.scss': 'css',
    'diagram.svg': 'image', 'photo.HEIC': 'image', 'video.mp4': 'video', 'voice.opus': 'audio',
    'report.pdf': 'pdf', 'report.docx': 'document', 'slides.pptx': 'document', 'data.xlsx': 'spreadsheet',
    'table.csv': 'spreadsheet', 'release.tar.gz': 'archive', 'native.dll': 'binary', 'opaque.unknown': 'file',
  };
  for (const [path, kind] of Object.entries(cases)) assert.equal(describe(path).kind, kind, path);
  assert.equal(describe('C:\\RelayProjects\\demo\\APP.JS').name, 'APP.JS');
  assert.equal(describe('C:\\RelayProjects\\demo\\APP.JS').extension, 'js');
});

test('explicit directory identity overrides filename extensions and expanded folders have a distinct icon', () => {
  const folder = describe('src/types.ts', { directory: true }), expanded = describe('src/types.ts', { directory: true, expanded: true });
  assert.equal(folder.kind, 'folder'); assert.equal(expanded.kind, 'folder-open'); assert.notEqual(folder.icon, expanded.icon);
  assert.equal(folder.language, null); assert.equal(expanded.language, null);
});

test('dotfiles and build filenames identify content formats without pretending all lockfiles are JSON', () => {
  for (const name of ['.env', '.env.production', '.editorconfig', '.npmrc']) assert.equal(describe(name).language, 'ini', name);
  for (const name of ['.gitignore', '.dockerignore', 'yarn.lock']) assert.equal(describe(name).language, null, name);
  assert.equal(describe('Dockerfile').kind, 'code'); assert.equal(describe('Dockerfile.dev').kind, 'code');
  assert.equal(describe('Makefile').language, 'makefile'); assert.equal(describe('CMakeLists.txt').kind, 'code');
  assert.equal(describe('Cargo.lock').language, 'ini'); assert.equal(describe('Pipfile.lock').language, 'json');
  assert.equal(describe('package-lock.json').language, 'json'); assert.equal(describe('notebook.ipynb').language, 'json');
  assert.equal(describe('LICENSE').language, 'plaintext');
});

test('language hints resolve entirely in Relay’s bundled highlighter, including TSX, SVG and stylesheet variants', () => {
  const cases = ['app.js', 'app.cjs', 'app.ts', 'view.jsx', 'view.tsx', 'main.py', 'script.zsh', 'main.c', 'main.cpp',
    'main.cs', 'main.kt', 'main.go', 'main.rs', 'main.rb', 'main.php', 'main.lua', 'main.pl', 'main.swift', 'main.m',
    'data.sql', 'schema.graphql', 'main.vb', 'change.diff', 'view.vue', 'README.md', 'data.json', 'app.yaml',
    'app.toml', 'feed.xml', 'index.html', 'style.css', 'style.scss', 'style.less', 'icon.svg', 'note.txt', 'Makefile'];
  for (const name of cases) {
    const { language } = describe(name); assert.ok(language, name); assert.ok(highlight.getLanguage(language), name + ': ' + language);
  }
  assert.equal(describe('view.tsx').language, 'typescript'); assert.equal(describe('view.jsx').language, 'javascript');
  assert.equal(describe('run.ps1').language, null, 'unsupported local grammars must not be guessed');
});

test('unknown, malformed and control-bearing filenames fall back safely without requiring a DOM', () => {
  for (const value of [null, undefined, {}, '', '\u0000bad.js', 'line\nname.py', 'README.unusual']) assert.equal(describe(value).kind, 'file');
  assert.equal(describe('normal.js', null).kind, 'javascript');
  assert.throws(() => createIcon('normal.js'), /requires a document/);
});

test('SVG identity uses only static artwork; untrusted filenames and accessible titles are never parsed into it', () => {
  const original = global.document;
  global.document = { createElementNS(namespace, tagName) { return { namespace, tagName, attributes: {}, children: [],
    setAttribute(key, value) { this.attributes[key] = value; }, appendChild(node) { this.children.push(node); } }; } };
  try {
    const names = ['app.js', 'app.ts', 'view.tsx', 'main.py', 'run.sh', 'notes.md', 'data.json', 'style.css', 'index.html',
      'image.png', 'movie.mp4', 'voice.mp3', 'report.pdf', 'report.docx', 'data.csv', 'files.zip', 'native.exe', 'unknown'];
    const icons = names.map(name => createIcon(name));
    assert.equal(new Set(icons.map(icon => icon.innerHTML)).size, names.length, 'file kinds have different outlines, not just different colors');
    for (let index = 0; index < names.length; index++) {
      assert.equal(icons[index].attributes.class, 'workspace-file-icon');
      assert.equal(icons[index].attributes['data-file-kind'], describe(names[index]).kind);
      assert.equal(icons[index].attributes['aria-hidden'], 'true');
      assert.doesNotMatch(icons[index].innerHTML, /<script|<image|href=|onload=/i);
    }
    const payload = '<svg onload=alert(1)>.js';
    const titled = createIcon(payload, { title: payload, className: 'preview-kind-icon' });
    assert.doesNotMatch(titled.innerHTML, /onload|alert/); assert.equal(titled.children[0].textContent, payload);
    assert.equal(titled.attributes['aria-label'], payload); assert.equal(titled.attributes.role, 'img');
    assert.match(titled.attributes.class, /preview-kind-icon/);
  } finally { if (original === undefined) delete global.document; else global.document = original; }
});
