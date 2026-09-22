'use strict';
// Real SDK Query transport with an in-memory CLI peer. Exercises SDK field
// mapping/cancellation; does not claim a provider exposes the fallback gate.
const { EventEmitter } = require('node:events'), { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { loadSdk } = require('../src/main/sdk/claude-sdk'), { createUserDialogHandler, SUPPORTED_DIALOG_KINDS } = require('../src/main/sdk/sdk-user-dialog');
const out = path.join(__dirname, '../.codex-tmp/sdk-medium-runtime'); fs.mkdirSync(out, { recursive: true });
const report = { scope: 'Real sdk.mjs, simulated CLI transport, no provider request', checks: [], errors: [] }; let query;
(async () => {
  const proc = new EventEmitter(), frames = [], send = value => proc.stdout.write(JSON.stringify(value) + '\n'); let raw = '', aborted = false;
  Object.assign(proc, { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, exitCode: null, signalCode: null });
  proc.stdin = new Writable({ write(chunk, _encoding, done) {
    raw += chunk.toString(); let at;
    while ((at = raw.indexOf('\n')) >= 0) { const line = raw.slice(0, at); raw = raw.slice(at+1); if (!line.trim()) continue; const event = JSON.parse(line); frames.push(event);
      if (event.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { commands: [], models: [], account: {}, output_style: 'default', available_output_styles: ['default'] } } });
    } done();
  } });
  proc.kill = () => { if (proc.killed) return true; proc.killed = true; proc.exitCode = 0; proc.stdout.end(); proc.stderr.end(); proc.emit('exit', 0, null); return true; };
  proc.stdin.on('finish', () => proc.kill());
  const wait = async condition => { const end = Date.now()+5000; while (!condition()) { if (Date.now()>end) throw Error('Transport fixture timeout'); await new Promise(r=>setTimeout(r,10)); } };
  let pending = false;
  const handler = createUserDialogHandler({ context: () => ({ conversationId: 'c', runId: 'r', windowId: 1, allowedModels: ['fallback'] }),
    broker: { registerToolUse: async ({ input, sdkOptions }) => {
      if (pending) return await new Promise(resolve => sdkOptions.signal.addEventListener('abort', () => { aborted = true; resolve({ behavior: 'deny' }); }, { once: true }));
      return { behavior: 'allow', updatedInput: { answers: { [input.questions[0].question]: '使用备用模型重试' } } };
    } } });
  try {
    const sdk = await loadSdk();
    query = sdk.query({ prompt: (async function* () { yield { type:'user',session_id:'',parent_tool_use_id:null,message:{role:'user',content:'fixture'} }; })(), options: { pathToClaudeCodeExecutable: process.execPath, settingSources: [], spawnClaudeCodeProcess: () => proc, onUserDialog: handler, supportedDialogKinds: SUPPORTED_DIALOG_KINDS, persistSession: false } });
    await query.initializationResult();
    const init = frames.find(x=>x.request?.subtype==='initialize'); assert.deepEqual(init.request.supportedDialogKinds, ['refusal_fallback_prompt']); report.checks.push('initialize advertises exactly the implemented dialog kind');
    send({ type:'control_request',request_id:'known',request:{subtype:'request_user_dialog',dialog_kind:'refusal_fallback_prompt',payload:{originalModel:'original',fallbackModel:'fallback'}} });
    await wait(()=>frames.some(x=>x.response?.request_id==='known'));
    assert.deepEqual(frames.find(x=>x.response?.request_id==='known').response.response, {behavior:'completed',result:'retry_fallback'}); report.checks.push('SDK maps dialog_kind to dialogKind and returns the validated choice');
    send({ type:'control_request',request_id:'unknown',request:{subtype:'request_user_dialog',dialog_kind:'future-kind',payload:{}} });
    await wait(()=>frames.some(x=>x.response?.request_id==='unknown'));
    assert.equal(frames.find(x=>x.response?.request_id==='unknown').response.subtype,'error'); report.checks.push('undeclared kind returns transport error without dismissing another consumer dialog');
    pending = true;
    send({ type:'control_request',request_id:'cancelled',request:{subtype:'request_user_dialog',dialog_kind:'refusal_fallback_prompt',payload:{originalModel:'original',fallbackModel:'fallback'}} });
    await new Promise(r=>setTimeout(r,30)); send({type:'control_cancel_request',request_id:'cancelled'}); await wait(()=>aborted); report.checks.push('SDK cancellation reaches the scoped interaction AbortSignal');
    report.ok = true;
  } catch (error) { report.ok=false;report.errors.push(error.stack||String(error));process.exitCode=1; }
  finally { proc.kill(); await query?.return(); fs.writeFileSync(path.join(out, 'dialog-transport.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
