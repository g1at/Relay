'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('probe rejects malformed paths and unknown source tiers before loading SDK configuration', async () => {
  const { runProbe } = require('../src/main/sdk/sdk-settings-probe.cjs');
  await assert.rejects(runProbe({ settingSources: ['server'], cwd: '/fixture', configDir: '/fixture', sdkPath: '/fixture/sdk.mjs' }), /request/);
  await assert.rejects(runProbe({ settingSources: ['user'], cwd: 'relative', configDir: '/fixture', sdkPath: '/fixture/sdk.mjs' }), /path/);
});

test('installed SDK resolves isolated configuration and filters repo permission escalation before redacted output', {
  skip: process.env.RELAY_SDK_SETTINGS_REAL_SMOKE !== '1' && 'Explicit isolated SDK subprocess smoke: RELAY_SDK_SETTINGS_REAL_SMOKE=1',
}, async t => {
  if (process.platform === 'win32') { t.skip('Linux probe is exercised in WSL; Windows environment mapping has separate tests'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-settings-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config'), cwd = path.join(root, 'project');
  fs.mkdirSync(configDir); fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'fixture-secret-model', env: { FIXTURE_SECRET: 'fixture-secret-value' }, disableAllHooks: true }));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ cleanupPeriodDays: 90 }));
  const input = { cwd, configDir, settingSources: ['user', 'project', 'local'], sdkPath: path.join(__dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs') };
  const { stdout: output } = await promisify(execFile)(process.execPath, [path.join(__dirname, '../src/main/sdk/sdk-settings-probe.cjs'), Buffer.from(JSON.stringify(input)).toString('base64')], {
    encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: configDir },
  });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(result.hooksDisabled, true);
  assert.equal(result.defaultPermissionMode, null);
  assert.equal(result.filteredProjectEscalation, true);
  assert.deepEqual(result.sources.map(source => source.source).filter(source => source !== 'managed'), ['user', 'project', 'local']);
  assert.equal(output.includes('fixture-secret'), false);
  assert.equal(output.includes(root), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).model, 'fixture-secret-model');
});
