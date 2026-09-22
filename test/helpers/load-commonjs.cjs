'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Execute the actual module with explicit environment substitutes. This keeps
// factory tests independent of Electron and personal data without source slicing.
module.exports = function loadCommonJs(relativeFile, { globals = {}, modules = {} } = {}) {
  const file = path.resolve(__dirname, '../..', relativeFile);
  const localRequire = createRequire(file);
  const context = vm.createContext({ process, Buffer, URL, console, setTimeout, clearTimeout,
    setInterval, clearInterval, setImmediate, clearImmediate, ...globals });
  const factory = new vm.Script(`(function(require, module, exports, __dirname, __filename) {\n${fs.readFileSync(file, 'utf8')}\n})`,
    { filename: file }).runInContext(context);
  const loaded = { exports: {} };
  const requireModule = name => Object.hasOwn(modules, name) ? modules[name] : localRequire(name);
  requireModule.resolve = localRequire.resolve;
  factory(requireModule, loaded, loaded.exports, path.dirname(file), file);
  return loaded.exports;
};
