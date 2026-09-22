'use strict';

const path = require('node:path');

// This module is also loaded by ordinary Node workers and WSL helpers. Keep it
// independent of Electron, process.cwd(), and the currently selected project.
const appRoot = path.resolve(__dirname, '../../..');
const resourcePath = (...segments) => path.join(appRoot, ...segments);
const unpackPath = file => file.replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked');
const unpackedPath = (...segments) => unpackPath(resourcePath(...segments));

module.exports = { appRoot, resourcePath, unpackPath, unpackedPath };
