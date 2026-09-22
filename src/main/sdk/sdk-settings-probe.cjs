'use strict';

// Runs inside the selected execution environment, not in Electron's renderer.
// No model query or config mutation is performed. Raw settings never leave this
// process: credentials, hook commands and full filenames are excluded.
const { pathToFileURL } = require('node:url');
const { summarizeResolvedSettings } = require('./sdk-runtime-policy');

async function runProbe(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.settingSources)
    || input.settingSources.some(source => !['user', 'project', 'local'].includes(source))) throw Error('Invalid diagnostic request');
  for (const key of ['cwd', 'configDir', 'sdkPath']) {
    if (typeof input[key] !== 'string' || !input[key].startsWith('/') || input[key].includes('\0')) throw Error('Invalid diagnostic path');
  }
  process.env.CLAUDE_CONFIG_DIR = input.configDir;
  const sdk = await import(pathToFileURL(input.sdkPath).href);
  const raw = await sdk.resolveSettings({ cwd: input.cwd, settingSources: input.settingSources });
  return { ok: true, ...summarizeResolvedSettings(raw, sdk.filterEscalatingDefaultMode(raw)) };
}

if (require.main === module) {
  let request;
  try {
    if (!process.argv[2] || process.argv[2].length > 32768) throw Error();
    request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  } catch (_) { process.stdout.write(JSON.stringify({ ok: false, error: '配置诊断请求无效。' })); process.exitCode = 1; }
  if (request) runProbe(request).then(result => process.stdout.write(JSON.stringify(result)), () => {
    process.stdout.write(JSON.stringify({ ok: false, error: 'WSL 配置诊断暂不可用，未修改运行配置。' })); process.exitCode = 1;
  });
}

module.exports = { runProbe };
