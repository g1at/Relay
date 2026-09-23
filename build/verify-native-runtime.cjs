#!/usr/bin/env node
'use strict';

// Run only through release.verifyNativeRuntime: it starts the actual Electron
// executable with a disposable profile/environment before Electron initializes.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');

if (!process.versions.electron || process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('Native probe requires the actual Windows x64 Electron runtime.');
  process.exit(1);
}
const { app } = require('electron');
let terminal = null;
const directory = process.env.RELAY_NATIVE_PROBE_ROOT;
function fail(error) {
  console.error('Native runtime verification failed: ' + (error && error.stack || error));
  try { terminal?.kill(); } catch (_) {}
  app.exit(1);
}
try {
  if (!directory || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error('An existing isolated RELAY_NATIVE_PROBE_ROOT is required.');
  }
  for (const [name, folder] of Object.entries({ home: 'home', appData: 'appData', userData: 'profile',
    sessionData: 'session', crashDumps: 'crashes', temp: 'temp' })) {
    const location = path.join(directory, folder);
    fs.mkdirSync(location, { recursive: true });
    app.setPath(name, location);
  }
  app.setName('Relay Native Runtime Probe');
  app.disableHardwareAcceleration();
} catch (error) { fail(error); }

app.whenReady().then(async () => {
  const electronVersion = require('electron/package.json').version;
  if (process.versions.electron !== electronVersion) throw new Error('Electron executable differs from the installed dependency.');
  const nodePtyVersion = require('node-pty/package.json').version;
  if (nodePtyVersion !== '1.1.0') throw new Error('Only the locked node-pty 1.1.0 prebuild is supported.');
  const nativeRoot = path.dirname(require.resolve('node-pty/package.json'));
  const prebuildRoot = path.join(nativeRoot, 'prebuilds', 'win32-x64');
  if (!fs.statSync(prebuildRoot).isDirectory()) throw new Error('Windows x64 prebuilds are missing.');
  const pty = require('node-pty');
  const marker = 'RELAY_PTY_PROBE_' + randomUUID().replace(/-/g, '');
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const result = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { try { terminal?.kill(); } catch (_) {} reject(new Error('Native PTY command timed out.')); }, 15000);
    try {
      terminal = pty.spawn(cmd, ['/d', '/s', '/c', `echo ${marker}`], {
        name: 'xterm-color', cols: 120, rows: 30, cwd: directory, env: { ...process.env }, useConpty: true,
      });
      terminal.onData(data => { output = (output + data).slice(-16384); });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        const normalized = stripVTControlCharacters(output).replace(/\r/g, '');
        const markerObserved = normalized.split('\n').some(line => line.trim() === marker);
        if (exitCode !== 0 || !markerObserved) reject(new Error(`Native PTY failed: exit=${exitCode}, marker=${markerObserved}`));
        else resolve({ exitCode, markerObserved });
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
  terminal = null;
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const nativeFiles = Object.keys(require.cache).filter(file => file.endsWith('.node')
    && path.relative(nativeRoot, file).split(path.sep)[0] !== '..').map(file => {
    const digest = sha256(file), prebuilt = path.join(prebuildRoot, path.basename(file));
    if (!fs.existsSync(prebuilt) || sha256(prebuilt) !== digest) throw new Error(`Loaded native file does not match the shipped prebuild: ${file}`);
    return { file: path.relative(nativeRoot, file).replace(/\\/g, '/'), sha256: digest, matchesPrebuild: true };
  });
  if (nativeFiles.length === 0) throw new Error('No node-pty native addon was loaded.');
  console.log('RELAY_NATIVE_RUNTIME_OK ' + JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch,
    electronVersion, nodeVersion: process.versions.node, napiVersion: process.versions.napi, nodePtyVersion,
    ...result, nativeFiles }));
  app.exit(0);
}).catch(fail);
