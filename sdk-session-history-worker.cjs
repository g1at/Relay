'use strict';
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { invokeSessionOperation, publicError } = require('./sdk-session-history');

async function run(input) {
  let timer;
  try {
    if (!input || typeof input.sdkPath !== 'string' || !input.scope) throw Error('Invalid worker payload');
    // This is a dedicated process/thread, never Electron's process.env.
    process.env.CLAUDE_CONFIG_DIR = input.scope.configDir;
    timer = setTimeout(() => process.exit(2), Math.max(100, Math.min(input.timeoutMs || 15000, 60000)));
    const sdk = await import(pathToFileURL(input.sdkPath).href);
    const value = await invokeSessionOperation(sdk, input.scope, input.operation, input.args);
    if (Buffer.byteLength(JSON.stringify({ value })) > 4 * 1024 * 1024) {
      return { ok: false, code: 'SESSION_HISTORY_TOO_LARGE', message: '这页历史内容过大，请缩小读取范围。' };
    }
    return { ok: true, value };
  } catch (error) { return publicError(error); }
  finally { clearTimeout(timer); }
}
if (!isMainThread) run(workerData).then(result => parentPort.postMessage(result));
else {
  let raw = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 65536) process.exit(2); });
  process.stdin.on('end', async () => {
    try { process.stdout.write(JSON.stringify(await run(JSON.parse(raw)))); }
    catch (_) { process.stdout.write(JSON.stringify({ ok: false, code: 'SESSION_HISTORY_FAILED', message: '历史读取请求无效。' })); }
  });
}
