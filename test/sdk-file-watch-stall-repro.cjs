'use strict';
// Opt-in diagnostic fixture. Real bundled Windows SDK/CLI, two SERIAL isolated
// cases, synthetic loopback Anthropic server. Never loads user settings or MCP.
// Run mechanism comparison: node test/sdk-file-watch-stall-repro.cjs --run --profile --command-watch
// Omit --command-watch to test SDK SessionStart callback activation itself.
// No SDK process is created without --run. Raw logs/temporary homes are fixture-owned.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { StringDecoder } = require('node:string_decoder');

const LIMITS = Object.freeze({ scenarioMs: 55000, totalMs: 125000, privateBytes: 512 * 1024 * 1024,
  cpuMs: 20000, hookCalls: 500, debugBytes: 4 * 1024 * 1024, bodyBytes: 2 * 1024 * 1024,
  files: 16, rounds: 4, roundDelayMs: 70, quietMs: 3500, sampleMs: 1800 });
const repo = path.resolve(__dirname, '..');
const overrideArg = process.argv.find(arg => arg.startsWith('--cli='));
const executable = overrideArg ? path.resolve(overrideArg.slice(6)) : path.join(repo, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe');
const sdkFile = path.join(repo, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const outputRoot = path.join(repo, '.codex-tmp/sdk-stall-repro');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const elapsed = start => Math.round(performance.now() - start);
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|processor_architecture|processor_identifier|number_of_processors|os|programfiles|programfiles\(x86\)|programw6432)$/i.test(key)));

function environment(root, port, proxyPort) {
  const home = path.join(root, 'home'), config = path.join(root, 'config'), temp = path.join(root, 'temp');
  for (const dir of [home, config, temp, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), '{}\n');
  return { ...systemEnv, HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(path.parse(home).root.length - 1),
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), TEMP: temp, TMP: temp,
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: temp,
    ANTHROPIC_API_KEY: 'synthetic-file-watch-key', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_MODEL: 'fixture-file-watch-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '0', OTEL_SDK_DISABLED: 'true',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, ALL_PROXY: `http://127.0.0.1:${proxyPort}`,
    http_proxy: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}`, all_proxy: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  };
}
function safeDebug(file, root) {
  const counts = { fileChanged: 0, watcherChange: 0, hookTimeout: 0, hookFailure: 0, eventLoopStall: 0, controlError: 0 };
  if (!fs.existsSync(file)) return { bytes: 0, counts, evidence: [] };
  const stat = fs.statSync(file), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(Math.min(stat.size, LIMITS.debugBytes));
  fs.readSync(fd, buffer, 0, buffer.length, stat.size - buffer.length); fs.closeSync(fd);
  const evidence = [];
  for (const line of buffer.toString('utf8').split('\n')) {
    if (/FileChanged|hook_file_changed/.test(line)) counts.fileChanged++;
    if (/file_watcher_change_detected/.test(line)) counts.watcherChange++;
    if (/hook_callback_timeout|hook.*timed out/i.test(line)) counts.hookTimeout++;
    if (/FileChanged hook failed|hook_exec_failed/.test(line)) counts.hookFailure++;
    if (/event-loop-stall.*blocked|tengu_event_loop_stall/.test(line)) counts.eventLoopStall++;
    if (/control.*(?:error|failed|timeout)|No hook callback/i.test(line)) counts.controlError++;
    if (/FileChanged|file_watcher_change_detected|hook_callback_timeout|hook.*timed out|event-loop-stall.*blocked/i.test(line) && evidence.length < 80) {
      evidence.push(line.split(root).join('[fixture]').replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, '[path]')
        .replace(/(api[_-]?key|authorization|token)\s*[:=]\s*[^,\s]+/gi, '$1=[redacted]').slice(0,650));
    }
  }
  return { bytes: stat.size, sampledBytes: buffer.length, counts, evidence };
}
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
function reply(res, body, content) {
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content,
    stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 30, output_tokens: 12 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 30, output_tokens: 0 } } });
  content.forEach((block, index) => {
    emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
    emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    emit('content_block_stop', { type: 'content_block_stop', index });
  });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 12 } });
  emit('message_stop', { type: 'message_stop' }); res.end();
}
async function windowsSample(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Invalid owned PID');
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{pid=$p.Id;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;privateBytes=$p.PrivateMemorySize64;workingSetBytes=$p.WorkingSet64}|ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => cp.execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
    { windowsHide: true, timeout: 4000, maxBuffer: 16384, env: systemEnv }, (error, stdout) => {
      if (error) reject(Error('Owned process sample unavailable')); else { try { resolve(JSON.parse(stdout)); } catch { reject(Error('Malformed process sample')); } }
    }));
}
async function killOwned(child, report) {
  if (!child || child.exitCode !== null || child.signalCode !== null || report.childExited) return;
  // The PID is captured directly from this fixture's spawn, never discovered
  // by image-name matching. /T includes only descendants of that owned CLI.
  await new Promise(resolve => cp.execFile('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
    { windowsHide: true, timeout: 5000, maxBuffer: 16384 }, error => { report.forceStopped = true; report.forceStopError = !!error; resolve(); }));
}
async function runScenario(sdk, base, name, watchPaths, save, supervisor) {
  const root = path.join(base, name), cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
  const abortController = new AbortController();
  const start = performance.now(), debugFile = path.join(root, 'sdk-private.log');
  const report = { name, watchPaths, abortDiagnostic:process.argv.includes('--abort-diagnostic')||process.argv.includes('--abort-pending-hook'), abortPendingHook:process.argv.includes('--abort-pending-hook'), killCalls:[], streamCloseCalls:[], awaitInitialize:process.argv.includes('--await-initialize'), commandWatch:process.argv.includes('--command-watch'), watchDeclarations:0, watchResponseWritten:false, watchActivated:false, protocolHooks: [], protocolFrames: {}, startedAt: new Date().toISOString(), requests: [], hooks: [], samples: [], eventCounts: {}, results: [], toolResults: [], mutations: 0, errors: [], blockedProxyRequests: 0 };
  supervisor.currentReport = report;
  let child, query, inputWake, inputDone = false, stopping = false, stopReason = null, sampling = false, mode = 'warmup', hookActive = 0, pumpError = null;
  const inputs = [], activeHooks = new Map(), hookRequests = new Map(), toolId = 'fixture_tool_' + name, marker = 'FILE_WATCH_TOOL_' + name.toUpperCase();
  const command = `printf '${marker}\\n'`;
  const stop = reason => { if (stopReason) return; stopReason = reason; report.errors.push(reason); inputDone = true; inputWake?.(); try { query?.close(); } catch {} void killOwned(child, report); save(); };
  supervisor.stop = stop;
  const proxy = http.createServer((_req,res) => { report.blockedProxyRequests++; res.writeHead(403); res.end('fixture blocks non-loopback proxy traffic'); });
  proxy.on('connect', (_req,socket) => { report.blockedProxyRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  const server = http.createServer((req, res) => {
    let raw = '', rejected = false;
    req.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > LIMITS.bodyBytes) { rejected = true; req.destroy(); stop('Synthetic model request size limit'); } });
    req.on('end', () => {
      if (rejected) return;
      let body; try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400); res.end('{}'); return; }
      if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type':'application/json' }); res.end('{"input_tokens":30}'); return; }
      if (!req.url.includes('/messages')) { res.writeHead(404); res.end('{}'); return; }
      const receipt = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === toolId);
      report.requests.push({ atMs: elapsed(start), mode, syntheticCredential: req.headers['x-api-key'] === 'synthetic-file-watch-key',
        model: body.model, tools: (body.tools || []).map(tool => tool.name), hasReceipt: !!receipt, receiptHasMarker: !!receipt && JSON.stringify(receipt.content).includes(marker) });
      if (report.requests.length > 8) { res.writeHead(429); res.end('{}'); stop('Model request count limit'); return; }
      reply(res, body, mode === 'warmup' ? [{ type:'text', text:'FILE_WATCH_READY' }] : receipt
        ? [{ type:'text', text:'FILE_WATCH_COMPLETE' }]
        : [{ type:'tool_use', id:toolId, name:'Bash', input:{command, description:'Print isolated fixture marker', timeout:5000} }]);
    });
  });
  let deadline, sampleTimer, pump;
  try {
    await listen(server); await listen(proxy);
    const env = environment(root, server.address().port, proxy.address().port);
    if (process.argv.includes('--profile')) {
      const profiles = path.join(root, 'profiles'); fs.mkdirSync(profiles, { recursive: true });
      // Profiles are outside watched workspace and contain only synthetic work.
      env.BUN_OPTIONS = '--cpu-prof --cpu-prof-dir ' + profiles.replace(/\\/g, '/'); report.profileEnabled = true;
    }
    // The SDK host itself gets an isolated home as well as its child. This is
    // a standalone fixture process; no other Relay process's environment changes.
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
    const settings = {};
    if (report.commandWatch) {
      const commandFile=path.join(root,'session-start.cjs'), recordFile=path.join(root,'session-start.json');
      const response=watchPaths?{hookSpecificOutput:{hookEventName:'SessionStart',watchPaths:[cwd]}}:{};
      fs.writeFileSync(commandFile, "const fs=require('node:fs');let input;try{input=JSON.parse(fs.readFileSync(0,'utf8'));}catch{};fs.writeFileSync("+JSON.stringify(recordFile)+",JSON.stringify({kind:input?.hook_event_name,watchPathsReturned:"+JSON.stringify(watchPaths)+",at:new Date().toISOString()}));process.stdout.write("+JSON.stringify(JSON.stringify(response))+");");
      settings.hooks={SessionStart:[{hooks:[{type:'command',command:'\"'+process.execPath+'\" \"'+commandFile+'\"',timeout:5}]}]};
    }
    const hooks = {};
    for (const kind of ['SessionStart','StopFailure','Elicitation','ConfigChange','CwdChanged','FileChanged','PostToolUse']) hooks[kind] = [{ hooks: [async input => {
      const id = randomUUID(), began = performance.now(); activeHooks.set(id, began); hookActive++;
      const row = { kind, event: input.event || null, child: !!input.agent_id, atMs: elapsed(start),
        fileInsideFixture: input.file_path ? inside(cwd, path.resolve(input.file_path)) : null, active: hookActive };
      const wire = [...hookRequests.values()].find(request => request.kind === kind && request.callbackAtMs == null);
      if (wire) { wire.callbackAtMs = elapsed(start); row.requestId = wire.requestId; }
      report.hooks.push(row);
      try {
        if (report.hooks.length > LIMITS.hookCalls) stop('Hook count limit');
        if(report.abortPendingHook && kind==='PostToolUse'){report.heldHookAtMs=elapsed(start);report.heldHookToolMarker=JSON.stringify(input.tool_response||{}).includes(marker);await new Promise(()=>{});}
        if (watchPaths && !input.agent_id && ['SessionStart','CwdChanged'].includes(kind)) { report.watchDeclarations++; return { hookSpecificOutput:{ hookEventName:kind, watchPaths:[cwd] } }; }
        return {};
      } finally { row.durationMs = Math.round((performance.now() - began) * 1000) / 1000; activeHooks.delete(id); hookActive--; }
    }] }];
    query = sdk.query({ prompt:(async function* () { while (!inputDone) { if (inputs.length) yield inputs.shift(); else await new Promise(resolve => { inputWake = resolve; }); } })(), options: {
      cwd, env, abortController, pathToClaudeCodeExecutable: executable, model:'fixture-file-watch-model', systemPrompt:'Synthetic local fixture. Execute only the explicitly provided Bash printf tool and return its marker.',
      pluginsViaInitialize:process.argv.includes('--await-initialize'), settingSources:[], settings, mcpServers:{}, strictMcpConfig:true, tools:['Bash'], allowedTools:['Bash'], permissionMode:'bypassPermissions', allowDangerouslySkipPermissions:true,
      maxTurns:4, includePartialMessages:true, persistSession:false, thinking:{type:'disabled'}, hooks, debugFile,
      stderr: chunk => { report.stderrBytes = (report.stderrBytes || 0) + Buffer.byteLength(chunk); },
      spawnClaudeCodeProcess(options) {
        if (child) throw Error('Fixture permits one native CLI per scenario');
        if (path.resolve(options.command).toLowerCase() !== executable.toLowerCase()) throw Error('Unexpected SDK executable');
        if (path.resolve(options.cwd).toLowerCase() !== cwd.toLowerCase()) throw Error('Unexpected SDK cwd');
        child = cp.spawn(options.command, options.args, { cwd, env:{ ...options.env, ...env }, signal:options.signal, windowsHide:true, shell:false, stdio:['pipe','pipe','pipe'] });
        report.pid = child.pid; report.spawnSignalProvided=!!options.signal;
        const snapshot=()=>({killed:child.killed,exitCode:child.exitCode,signalCode:child.signalCode});
        const kill=child.kill;child.kill=function(signal){const entry={atMs:elapsed(start),signal:signal??null,before:snapshot()};report.killCalls.push(entry);try{entry.returned=kill.call(this,signal);return entry.returned;}catch(error){entry.error=error.code||error.name;throw error;}finally{entry.after=snapshot();}};
        for(const method of ['end','destroy']){const original=child.stdin[method];child.stdin[method]=function(...args){report.streamCloseCalls.push({method,atMs:elapsed(start)});return original.apply(this,args);};}
        report.spawnAwaitInitialize=options.args.includes('--await-initialize'); supervisor.ownedChild = child;
        // Passive stdout observer plus a forwarding stdin.write wrapper retain
        // only request IDs, lifecycle names and times; never payload contents.
        const observer = direction => {
          const decoder = new StringDecoder('utf8'); let pending = '';
          return chunk => {
            pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
            if (pending.length > LIMITS.bodyBytes) { pending = ''; stop('Protocol frame size limit'); return; }
            let newline;
            while ((newline = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
              let frame; try { frame = JSON.parse(line); } catch { continue; }
              const key = direction + ':' + String(frame.type || 'unknown'); report.protocolFrames[key] = (report.protocolFrames[key] || 0) + 1;
              if (direction === 'out' && frame.type === 'control_request' && frame.request?.subtype === 'hook_callback') {
                const request = { requestId: frame.request_id, callbackId: frame.request.callback_id, kind: frame.request.input?.hook_event_name || 'unknown', requestAtMs: elapsed(start) };
                hookRequests.set(request.requestId, request); report.protocolHooks.push(request);
                if (report.protocolHooks.length > LIMITS.hookCalls) stop('Hook protocol request limit');
              } else if (direction === 'in' && frame.type === 'control_response') {
                const request = hookRequests.get(frame.response?.request_id);
                if (request) { request.responseAtMs = elapsed(start); request.roundTripMs = request.responseAtMs - request.requestAtMs; request.responseType = frame.response.subtype; if (frame.response.response?.hookSpecificOutput?.watchPaths?.includes(cwd)) report.watchResponseWritten=true; hookRequests.delete(request.requestId); }
              } else if (direction === 'out' && frame.type === 'control_cancel_request') {
                const request = hookRequests.get(frame.request_id); if (request) request.cancelAtMs = elapsed(start);
              }
            }
          };
        };
        child.stdout.on('data', observer('out'));
        const noteInput = observer('in'), originalWrite = child.stdin.write;
        child.stdin.write = function (chunk, ...args) { noteInput(chunk); return originalWrite.call(this, chunk, ...args); };
        child.once('exit', (code, signal) => { report.nativeExitMs=elapsed(start); report.childExited = true; report.exitCode = code; report.exitSignal = signal; });
        child.once('error', error => { if (!stopping && !report.abort?.requestedMs) { report.errors.push('Owned CLI spawn/process error: ' + error.code); pumpError = error; } else if(report.abort)report.abort.nativeError=error.code||error.name; });
        return child;
      },
    } });
    deadline = setTimeout(() => stop('Scenario deadline'), LIMITS.scenarioMs);
    const sample = async () => {
      if (sampling || stopping || !child?.pid || report.childExited) return;
      sampling = true;
      try {
        const measured = await windowsSample(child.pid); if (report.childExited || stopping) return;
        report.samples.push({atMs:elapsed(start),...measured});
        if (measured.privateBytes > LIMITS.privateBytes) stop('Owned CLI private-memory limit');
        if (measured.cpuMs > LIMITS.cpuMs) stop('Owned CLI CPU-time limit');
        if (fs.existsSync(debugFile) && fs.statSync(debugFile).size > LIMITS.debugBytes) stop('Debug log size limit');
        save();
      } catch { report.sampleFailures = (report.sampleFailures || 0) + 1; if (report.sampleFailures >= 2) stop('Repeated owned-process sampling failure'); }
      finally { sampling = false; }
    };
    sampleTimer = setInterval(() => { void sample(); }, LIMITS.sampleMs);
    pump = (async () => { for await (const event of query) {
      const kind = event.type === 'system' ? 'system:' + event.subtype : event.type;
      report.eventCounts[kind] = (report.eventCounts[kind] || 0) + 1;
      if (event.type === 'result') report.results.push({ atMs:elapsed(start), isError:!!event.is_error, marker:event.result === 'FILE_WATCH_READY' ? 'ready' : event.result === 'FILE_WATCH_COMPLETE' ? 'complete' : 'other' });
      if (event.type === 'user') for (const block of Array.isArray(event.message?.content) ? event.message.content : []) if (block.type === 'tool_result' && block.tool_use_id === toolId)
        report.toolResults.push({atMs:elapsed(start),isError:!!block.is_error,markerPresent:JSON.stringify(block.content).includes(marker)});
    } })().catch(error => { pumpError = error; if (!stopping && !stopReason && !report.abort?.requestedMs) report.errors.push('SDK event pump: ' + String(error.message).replace(/[A-Za-z]:[\\/][^\s"']+/g,'[path]').slice(0,500)); if(report.abort)report.abort.pumpError=error.name||error.code; }).finally(()=>{report.pumpEndedMs=elapsed(start);});
    const until = async (predicate, label, timeout=22000) => { const untilAt=performance.now()+timeout; while (!predicate()) { if (stopReason) throw Error(stopReason); if (pumpError) throw Error('SDK event pump failed'); if (performance.now()>untilAt) throw Error('Timed out: '+label); await sleep(35); } };
    const send = text => { inputs.push({type:'user',uuid:randomUUID(),session_id:'',parent_tool_use_id:null,message:{role:'user',content:text}}); inputWake?.(); inputWake=null; };
    let initializationTimer; try { await Promise.race([query.initializationResult(), new Promise((_,reject) => { initializationTimer=setTimeout(() => reject(Error('Initialization deadline')),18000); })]); } finally { clearTimeout(initializationTimer); }
    report.hooksApplied=(await query.initializationResult()).hooks_applied; report.initializedMs = elapsed(start); send('FIXTURE_READY'); await until(() => report.results.some(r=>r.marker==='ready'), 'warmup response');
    await sample(); await sleep(300);
    const commandRecord=path.join(root,'session-start.json');if(report.commandWatch&&fs.existsSync(commandRecord))report.commandHook=JSON.parse(fs.readFileSync(commandRecord,'utf8'));
    if (watchPaths) await until(() => (report.watchDeclarations>0 && report.watchResponseWritten)||report.commandHook?.watchPathsReturned, 'native hook watchPaths declaration written', 5000);
    mode='workload'; const beforeHooks=report.hooks.length;
    const mutation = (async () => {
      for (let round=0;round<LIMITS.rounds;round++) {
        if(stopReason)break;
        for(let index=0;index<LIMITS.files;index++) { fs.writeFileSync(path.join(cwd,`fixture-${index}.txt`),`round=${round};file=${index};`+'x'.repeat(480)); report.mutations++; }
        await sleep(LIMITS.roundDelayMs);
      }
      report.mutationsDoneMs=elapsed(start); report.hooksAtMutationEnd=report.hooks.length;
    })();
    send('FIXTURE_PROBE: print the marker with the provided Bash command.');
    await mutation;
    if(report.abortPendingHook)await until(()=>report.heldHookAtMs!=null,'controlled PostToolUse callback hold');
    else await until(() => report.results.some(r=>r.marker==='complete'), 'tool result and final response');
    report.quietStartedMs=elapsed(start); if(!report.abortPendingHook)await sleep(LIMITS.quietMs);
    report.quietHookCalls=report.hooks.filter(h=>h.kind==='FileChanged'&&h.atMs>=report.quietStartedMs).length; report.delayedMutationHookCalls=report.hooks.filter(h=>h.kind==='FileChanged'&&h.atMs>report.mutationsDoneMs+500).length; report.fileChangedCalls=report.hooks.filter(h=>h.kind==='FileChanged').length; report.watchActivated=report.fileChangedCalls>0;
    report.workloadHookCalls=report.hooks.length-beforeHooks;
    report.ok=!stopReason && (!watchPaths||report.watchActivated) && (report.abortPendingHook?report.heldHookAtMs!=null&&report.heldHookToolMarker:report.requests.some(r=>r.hasReceipt&&r.receiptHasMarker) && report.results.some(r=>r.marker==='complete'&&!r.isError));
    if(report.abortDiagnostic && report.ok){
      const state=()=>({atMs:elapsed(start),killed:child.killed,exitCode:child.exitCode,signalCode:child.signalCode,nativeExited:!!report.childExited,pumpEnded:report.pumpEndedMs!=null,pendingHookRequests:hookRequests.size});
      report.abort={requestedMs:elapsed(start),before:state(),snapshots:[]};
      abortController.abort();report.abort.returnedMs=elapsed(start);report.abort.after=state();
      // This observation window intentionally does not call query.close(). Only
      // resource/time stop-loss may interrupt it; fallback cleanup follows it.
      for(let i=0;i<20&&!stopReason;i++){await sleep(500);report.abort.snapshots.push(state());save();}
      report.abort.observationEndedMs=elapsed(start);report.abort.nativeExitedWithinWindow=!!report.childExited;report.abort.queryEndedWithinWindow=report.pumpEndedMs!=null;
      report.abort.nativeExitAfterAbortMs=report.nativeExitMs==null?null:report.nativeExitMs-report.abort.requestedMs;report.abort.queryEndAfterAbortMs=report.pumpEndedMs==null?null:report.pumpEndedMs-report.abort.requestedMs;
      report.ok=report.ok&&!stopReason&&report.abort.nativeExitedWithinWindow&&report.abort.queryEndedWithinWindow;
      if(!report.ok)report.errors.push('Abort did not finish both public Query and owned native process during observation');
    }
    if (!report.ok) report.errors.push(watchPaths&&!report.watchActivated?'Watch paths declared but no native FileChanged callback observed':'No successful real tool receipt');
  } catch (error) { report.ok=false; if (!report.errors.includes(error.message)) report.errors.push(String(error.message).slice(0,500)); }
  finally {
    stopping=true; clearTimeout(deadline); clearInterval(sampleTimer); inputDone=true; inputWake?.();
    report.pendingProtocolHooks=hookRequests.size; report.maxProtocolRoundTripMs=Math.max(0,...report.protocolHooks.map(h=>h.roundTripMs||0));
    report.pendingHooks=activeHooks.size; report.maxPendingHookMs=Math.max(0,...[...activeHooks.values()].map(t=>performance.now()-t));
    try { query?.close(); } catch {}
    if (pump) await Promise.race([pump, sleep(2200)]);
    await killOwned(child, report);
    if (child && !report.childExited) await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(1500)]);
    server.closeAllConnections(); proxy.closeAllConnections(); await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>proxy.close(r))]);
    report.profiles=fs.existsSync(path.join(root,'profiles'))?fs.readdirSync(path.join(root,'profiles')).filter(file=>file.endsWith('.cpuprofile')):[];
    report.debug=safeDebug(debugFile,root); report.durationMs=elapsed(start); report.stoppedReason=stopReason;
    report.maxHookMs=Math.max(0,...report.hooks.map(h=>h.durationMs||0)); report.maxConcurrentHooks=Math.max(0,...report.hooks.map(h=>h.active||0));
    report.maxPrivateMiB=Math.round(Math.max(0,...report.samples.map(s=>s.privateBytes))/1024/1024);
    // Only remove raw logs created by this scenario. Synthetic evidence JSON,
    // isolated home and small workspace remain under this run for inspection.
    if(fs.existsSync(debugFile))fs.unlinkSync(debugFile);
    fs.writeFileSync(path.join(root,'debug-summary.json'),JSON.stringify(report.debug,null,2));
    supervisor.stop=null; supervisor.ownedChild=null; save();
  }
  return report;
}

async function main() {
  if (!process.argv.includes('--run')) {
    console.log(JSON.stringify({ optInRequired:true, command:'node test/sdk-file-watch-stall-repro.cjs --run [--profile] [--await-initialize] [--command-watch] [--cli=ABSOLUTE_PATH] [--abort-diagnostic|--abort-pending-hook]', limits:LIMITS,
      scenarios:['no-watch-paths','watch-cwd'], isolation:'Independent homes/config/cwd; settings=[], MCP={}, synthetic loopback model; external proxy requests denied; serial owned CLI only' },null,2)); return;
  }
  if(process.platform!=='win32')throw Error('Run this fixture using native Windows Node');
  const base=path.join(outputRoot,new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid); fs.mkdirSync(base,{recursive:true});
  const sdkVersion=JSON.parse(fs.readFileSync(path.join(repo,'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),'utf8')).version;
  const cliVersion=JSON.parse(fs.readFileSync(path.join(repo,'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/package.json'),'utf8')).version;
  const report={startedAt:new Date().toISOString(),sdkVersion,cliPackageVersion:cliVersion,cliOverride:!!overrideArg,executable,host:{node:process.versions.node,electron:process.versions.electron||null,execPath:process.execPath},platform:process.platform,limits:LIMITS,cases:[],notes:['Controlled local comparison, not a reproduction of all production workload conditions.','Proxy denial plus disabled SDK telemetry prevents intended outbound service traffic; no real provider credentials supplied.']};
  const supervisor={}; const save=()=>fs.writeFileSync(path.join(base,'report.json'),JSON.stringify({...report,current:supervisor.currentReport},null,2));
  const timer=setTimeout(()=>{report.totalDeadline=true;supervisor.stop?.('Total fixture deadline');void killOwned(supervisor.ownedChild,supervisor.currentReport||{});save();process.exitCode=1;},LIMITS.totalMs);
  try {
    // Isolate SDK-module initialization too, before its first dynamic import.
    const env=environment(path.join(base,'host'),1,1); for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env);
    const sdk=await import(pathToFileURL(sdkFile).href);
    const scenarios=process.argv.includes('--abort-pending-hook')?[['abort-pending-hook',false]]:process.argv.includes('--abort-diagnostic')?[['abort-idle',false]]:[['no-watch-paths',false],['watch-cwd',true]];
    for(const [name,watch]of scenarios) {
      if(report.totalDeadline)break;
      const result=await runScenario(sdk,base,name,watch,save,supervisor); report.cases.push(result);supervisor.currentReport=null;save();
      // Stop-loss takes precedence over completing the comparison.
      if(result.stoppedReason){report.comparisonIncomplete=true;break;}
    }
    report.ok=report.cases.length===scenarios.length&&report.cases.every(c=>c.ok);
    report.inference=report.ok?'Small bounded comparison completed; examine hook counts and quiet-period activity. This does not rule out scale-, tool-, or runtime-state-dependent stalls.':'Comparison incomplete or local failure; do not attribute it to FileChanged without the per-case evidence.';
    if(!report.ok)process.exitCode=1;
  } finally { clearTimeout(timer);report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({ok:report.ok,report:path.join(base,'report.json'),cases:report.cases.map(c=>({name:c.name,ok:c.ok,mutations:c.mutations,hooks:c.hooks.length,quietHookCalls:c.quietHookCalls,maxHookMs:c.maxHookMs,maxPrivateMiB:c.maxPrivateMiB,watchActivated:c.watchActivated,errors:c.errors}))},null,2)); }
}
main().catch(error=>{console.error(String(error.stack||error));process.exitCode=1;});
