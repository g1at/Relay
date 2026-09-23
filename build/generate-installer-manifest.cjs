'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeManifest(payloadDir, destination, version, productName) {
  const builderVersion = require('app-builder-lib/package.json').version;
  if (builderVersion !== '25.1.8') {
    throw new Error(`Relay's NSIS compatibility hooks require review for electron-builder ${builderVersion}; tested version: 25.1.8`);
  }
  const root = path.resolve(payloadDir);
  const files = [];
  const visit = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(dir, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Reparse/symlink payload is unsupported: ${file}`);
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(file);
        files.push({ path: name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      } else throw new Error(`Unsupported payload entry: ${file}`);
    }
  };
  visit(root);
  for (const required of [`${productName}.exe`, 'resources/app.asar']) {
    if (!files.some((file) => file.path === required)) throw new Error(`Missing installer payload file: ${required}`);
  }
  const manifest = { schema: 1, version, productName, files };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const destination = path.join(__dirname, 'installer-payload-manifest.json');
  writeManifest(context.appOutDir, destination, context.packager.appInfo.version, context.packager.appInfo.productFilename);
}
module.exports = afterPack;
module.exports.writeManifest = writeManifest;
