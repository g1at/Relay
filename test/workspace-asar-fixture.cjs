'use strict';
// A dependency-only packaging fixture: no Relay settings, history or application startup.
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp', 'workspace-asar-smoke');
const stage = path.join(out, 'stage');
const archive = path.join(out, 'app.asar');
for (const generated of [stage, archive, archive + '.unpacked']) fs.rmSync(generated, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'node_modules'), { recursive: true });
fs.cpSync(path.join(root, 'node_modules', 'node-pty'), path.join(stage, 'node_modules', 'node-pty'), { recursive: true });
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'relay-workspace-native-fixture', version: '1.0.0' }));
asar.createPackageWithOptions(stage, archive, { unpackDir: 'node_modules/node-pty' }).then(() => {
  console.log('Terminal dependency fixture ready');
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
