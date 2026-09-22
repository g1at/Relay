'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { appRoot, resourcePath, unpackPath, unpackedPath } = require('../src/main/app/paths');

const root = path.resolve(__dirname, '..');
const filesIn = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? filesIn(file) : /\.(?:c?js)$/.test(file) ? [file] : [];
});

test('application resources do not follow the selected project or process cwd', () => {
  assert.equal(appRoot, root);
  const entry = path.join(root, 'src/main/app/paths.js');
  const actual = execFileSync(process.execPath, ['-e',
    'process.stdout.write(require(process.argv[1]).resourcePath("renderer", "index.html"))', entry],
  { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true });
  assert.equal(actual, path.join(root, 'renderer', 'index.html'));
  assert.equal(resourcePath('preload.js'), path.join(root, 'preload.js'));
  assert.equal(unpackedPath('src', 'main', 'tasks', 'task-progress-worker.js'),
    path.join(root, 'src', 'main', 'tasks', 'task-progress-worker.js'));
});

test('executable paths expand the ASAR segment once and keep nested module directories', () => {
  for (const file of [
    '/Program Files/Relay/resources/app.asar/src/main/tasks/task-progress-worker.js',
    'D:\\程序\\Relay\\resources\\app.asar\\src\\main\\sdk\\sdk-settings-probe.cjs',
  ]) {
    assert.equal(unpackPath(file), file.replace('app.asar', 'app.asar.unpacked'));
    assert.equal(unpackPath(unpackPath(file)), unpackPath(file));
  }
  assert.equal(unpackPath('/projects/my-app.asar/source.js'), '/projects/my-app.asar/source.js');
  assert.equal(unpackPath('/projects/app.asar-copy/source.js'), '/projects/app.asar-copy/source.js');
});

test('every literal local runtime import resolves from its actual module directory', () => {
  const files = [...filesIn(path.join(root, 'src/main')),
    path.join(root, 'main.js'), path.join(root, 'preload.js'), path.join(root, 'browser-page-preload.js')];
  const graph = new Map();
  for (const file of files) {
    const localRequire = createRequire(file);
    const imports = [...fs.readFileSync(file, 'utf8').matchAll(/\brequire(?:\.resolve)?\(\s*['"](\.[^'"\n]+)['"]\s*\)/g)];
    const edges = [];
    for (const [, specifier] of imports) {
      let resolved;
      assert.doesNotThrow(() => { resolved = localRequire.resolve(specifier); }, `${path.relative(root, file)} -> ${specifier}`);
      edges.push(resolved);
    }
    graph.set(file, edges);
  }
  const complete = new Set();
  function visit(file, ancestors = []) {
    assert.ok(!ancestors.includes(file), `local module cycle: ${[...ancestors, file].map(value => path.relative(root, value)).join(' -> ')}`);
    if (complete.has(file)) return;
    for (const dependency of graph.get(file) || []) if (graph.has(dependency)) visit(dependency, [...ancestors, file]);
    complete.add(file);
  }
  for (const file of graph.keys()) visit(file);
});
