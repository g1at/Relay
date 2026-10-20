'use strict';

// Compile both real electron-builder template branches. Never execute either
// compiled installer: the final package deliberately contains a non-executable
// uninstaller placeholder and is explicitly marked NOT-FOR-INSTALL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (process.platform !== 'win32') {
  console.log('SKIP: use Windows Node with the cached NSIS toolchain.');
  process.exit(0);
}
const repo = path.resolve(__dirname, '..');
const root = path.join(repo, '.codex-tmp', 'installer-nsis-build');
const project = path.join(root, 'fixture-project');
const payload = path.join(root, 'fixture-payload');
const out = path.join(root, 'compiled-not-for-install');
const resources = path.join(root, 'fixture-resources');
fs.cpSync(path.join(repo, 'build'), resources, { recursive: true });
for (const dir of [project, path.join(payload, 'resources'), out]) fs.mkdirSync(dir, { recursive: true });
const packageJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const nsisHome = process.env.RELAY_TEST_NSIS_HOME || path.join(process.env.LOCALAPPDATA, 'electron-builder', 'cache', 'nsis', 'nsis-3.0.4.1');
assert.ok(fs.existsSync(path.join(nsisHome, 'Bin', 'makensis.exe')), 'A local NSIS compiler is required; no download is requested by this fixture.');
process.env.ELECTRON_BUILDER_NSIS_DIR = nsisHome;
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
  name: 'relay-installer-compile-fixture', version: '0.0.0', productName: 'Relay Fixture',
  description: 'NOT FOR INSTALL: static NSIS compilation fixture', author: 'Relay tests',
}));
fs.writeFileSync(path.join(payload, 'Relay Fixture.exe'), 'NOT AN EXECUTABLE: only compile template file-existence dependencies.\n');
fs.writeFileSync(path.join(payload, 'resources', 'app.asar'), 'NOT AN ASAR: isolated compile fixture.\n');

require('../build/generate-installer-manifest.cjs').writeManifest(payload, path.join(resources, 'installer-payload-manifest.json'), '0.0.0', 'Relay Fixture');

const { build, Platform } = require('electron-builder');
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
const { nsisTemplatesDir } = require('app-builder-lib/out/targets/nsis/nsisUtil');
const { Arch } = require('builder-util');
const originalCompute = NsisTarget.prototype.computeScriptAndSignUninstaller;
const originalCompile = NsisTarget.prototype.executeMakensis;
const results = [];
NsisTarget.prototype.executeMakensis = async function (defines, commands, script) {
  const phase = Object.hasOwn(defines, 'BUILD_UNINSTALLER') ? 'uninstaller' : 'installer';
  assert.notEqual(this.options.warningsAsErrors, false, 'Production NSIS warnings remain errors.');
  fs.writeFileSync(path.join(root, `${phase}.nsi`), script);
  fs.writeFileSync(path.join(root, `${phase}-options.json`), JSON.stringify({ defines, commands }, null, 2));
  await originalCompile.call(this, defines, commands, script);
  const executable = commands.OutFile.replaceAll('"', '');
  assert.ok(fs.statSync(executable).size > 0, `${phase}: makensis produced an executable`);
  fs.copyFileSync(executable, path.join(root, `SANDBOX-NOT-FOR-INSTALL-${phase}.exe`));
  results.push(phase);
};
NsisTarget.prototype.computeScriptAndSignUninstaller = async function (defines, commands, installerPath, sharedHeader, archs) {
  // This replaces only builder's extraction-by-executing-the-generator step.
  // The real script, common header, architecture macros and production include
  // still go through the original makensis method with -WX enabled.
  const script = fs.readFileSync(path.join(nsisTemplatesDir, 'installer.nsi'), 'utf8');
  const placeholder = path.join(out, 'NOT-A-REAL-UNINSTALLER.bin');
  defines.BUILD_UNINSTALLER = null;
  defines.UNINSTALLER_OUT_FILE = placeholder;
  this.packager.sign = async () => {}; // Never discover/use personal certificates.
  await this.executeMakensis(defines, commands, sharedHeader + await this.computeFinalScript(script, false, archs));
  fs.writeFileSync(placeholder, 'NOT EXECUTABLE. Compile fixture only.\n');
  delete defines.BUILD_UNINSTALLER;
  return script;
};

(async () => {
  try {
    await build({
      projectDir: project,
      prepackaged: payload,
      targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
      publish: 'never',
      config: {
        extends: null,
        appId: 'dev.relay.installer.compile.fixture',
        productName: 'Relay Fixture',
        electronVersion: require('electron/package.json').version,
        directories: { output: out, buildResources: resources },
        artifactName: 'SANDBOX-NOT-FOR-INSTALL-${version}-${arch}.${ext}',
        forceCodeSigning: false,
        win: { target: ['nsis'], icon: path.join(repo, 'build', 'icon.ico'), signAndEditExecutable: false },
        nsis: {
          ...packageJson.build.nsis,
          include: path.join(resources, 'installer.nsh'),
          installerIcon: path.join(repo, 'build', 'icon.ico'),
          uninstallerIcon: path.join(repo, 'build', 'icon.ico'),
          installerHeaderIcon: path.join(repo, 'build', 'icon.ico'),
          differentialPackage: false,
          warningsAsErrors: true,
        },
      },
    });
    assert.deepEqual(results, ['uninstaller', 'installer']);
    console.log(`PASS: real electron-builder ${require('electron-builder/package.json').version} installer + BUILD_UNINSTALLER compiled with warnings as errors; no generated executable was run. Evidence: ${root}`);
  } finally {
    NsisTarget.prototype.computeScriptAndSignUninstaller = originalCompute;
    NsisTarget.prototype.executeMakensis = originalCompile;
  }
})().catch((error) => { console.error(error); process.exit(1); });
