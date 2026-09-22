'use strict';
// Real bundled SDK and CLI; temporary resources, synthetic credentials and loopback only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const relay = require('../src/main/sdk/claude-sdk');
const { InteractionBroker } = require('../src/main/tasks/interaction-broker');
const { createConversationPermissions } = require('../src/main/projects/conversation-permissions');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sdk-priority-'));
const config = path.join(base, 'config'), cwd = path.join(base, 'workspace');
fs.mkdirSync(config); fs.mkdirSync(cwd); fs.writeFileSync(path.join(config, 'settings.json'), '{}');
const source = path.join(cwd, 'fixture.txt'); fs.writeFileSync(source, 'local fixture only');
const output = path.join(__dirname, '../.codex-tmp/permission-live-switch'); fs.mkdirSync(output, { recursive: true });
const report = { sdk: require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'], cli: relay.bundledClaudeVersion(), checks: [], scenarios: [] };
let active, server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) { const end = Date.now() + 30000; while (!test()) { if (Date.now() > end) throw Error('Timed out: ' + label); await sleep(20); } }
function check(name, value) { assert.ok(value, name); report.checks.push(name); }
function send(res, body, blocks) {
  const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model, content: blocks,
    stop_reason: blocks.some(item => item.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 8 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  blocks.forEach((block, index) => {
    emit('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    emit('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    emit('content_block_stop', { type: 'content_block_stop', index });
  });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } });
  emit('message_stop', { type: 'message_stop' }); res.end();
}

async function scenario(name, toolName, target, url, behavior = 'pending') {
  const state = active = { name, requests: [], events: [], results: [], release: null, session: null, callbacks: [], mcpCalls: 0 };
  const id = randomUUID(), runId = randomUUID(), destination = path.join(cwd, name + '.txt');
  const broker = new InteractionBroker({ logger: { warn() {} } });
  let committed = null, settings = { permissionMode: behavior === 'narrow' ? 'bypassPermissions' : 'default' };
  let record = { id, turns: [] };
  const question = { questions: [{ header: 'Fixture', question: 'Which fixture?', options: [{label:'One',description:'First fixture'}, {label:'Two',description:'Second fixture'}], multiSelect: false }] };
  state.tool = { type: 'tool_use', id: 'tool_' + randomUUID(), name: toolName, input: toolName === 'Write' ? { file_path: destination, content: 'local fixture only' } : toolName === 'Bash' ? { command: 'printf relay_permission_fixture > relay-permission-bash.txt', description: 'Write a local fixture marker' } : toolName === 'AskUserQuestion' ? question : { value: 'local MCP fixture' } };
  const runtimeEnv = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic-priority-key', ANTHROPIC_BASE_URL: url,
    ANTHROPIC_MODEL: 'fixture-model', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256',
    ...(process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' } : {}),
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const session = state.session = relay.createLiveSession({ cwd, model: 'fixture-model', runtimeEnv,
    tools: ['Write', 'Bash', 'AskUserQuestion'], permissionMode: settings.permissionMode,
    mcpServersFactory: sdk => ({ 'relay-permission-fixture': sdk.createSdkMcpServer({name:'relay-permission-fixture',version:'1.0.0',tools:[
      sdk.tool('echo', 'Print a local fixture marker', {value:require('zod').z.string()}, async({value})=>{state.mcpCalls++;return {content:[{type:'text',text:value}]};})
    ]}) }),
    canUseTool: async (name, input, options) => {
      state.callbacks.push({name, reason: options.decisionReason || null, blockedPath: options.blockedPath || null, matchedAskRule: options.matchedAskRule || null});
      return broker.registerToolUse({toolName:name,input,sdkOptions:options,context:{conversationId:id,runId,permissionReconciliation:committed}});
    },
    onMessage(event) { state.events.push(event); if (event.type === 'result') state.results.push(event); },
    onExit(code,error) { state.exit = {code,error}; },
  });
  const permissions = createConversationPermissions({readSettings:()=>settings,writeSettings:value=>{settings=value;},loadConversation:()=>structuredClone(record),persistConversation:value=>{record=structuredClone(value);},
    applyRuntime: async (_, next) => { committed=null;await session.setPermissionMode(next.permissionMode);return()=>{committed={conversationId:id,runId,revision:next.revision,permissionMode:next.permissionMode,cwd};broker.reconcilePermissionMode(committed);}; },
    stopRuntime:()=>session.kill(),
  });
  permissions.protectSave(record,null);
  const switchTo = async mode => { const result=await permissions.set({conversationId:id,permissionMode:mode});check(name+': committed '+mode,result.ok&&record.permissionMode===mode); };
  try {
    check(name+': started',session.push('Use exactly this fixture tool then finish: '+toolName,{uuid:runId}));
    await until(()=>state.release,name+' API');
    if (behavior==='before' || behavior==='narrow') await switchTo(target);
    state.release();
    if (behavior!=='before') {
      await until(()=>broker.size>0,name+' permission');
      check(name+': initial callback parked',state.results.length===0);
      if(behavior!=='narrow')await switchTo(target);
      await sleep(100);
      if(toolName==='mcp__relay-permission-fixture__echo' && target==='acceptEdits') {
        check(name+': edit mode preserves MCP approval',broker.size===1&&state.mcpCalls===0);await switchTo('bypassPermissions');
      } else if(toolName==='AskUserQuestion') {
        check(name+': bypass preserves user question',broker.size===1&&state.results.length===0);
        broker.respond(broker.list()[0].id,{action:'submit',answers:{'Which fixture?':'One'}});
      } else if(behavior==='narrow') {
        check(name+': downgrade requires a fresh approval',broker.size===1&&!fs.existsSync(destination));
        broker.respond(broker.list()[0].id,{action:'allow_once'});
      }
    }
    await until(()=>state.results.length,name+' final result');
    check(name+': completed without interruption',state.results.every(e=>!e.is_error&&!e.permission_denials?.length&&!/^aborted_/.test(e.terminal_reason||'')));
    check(name+': no pending request remains',broker.size===0);
    if(toolName==='Write')check(name+': wrote the local fixture',fs.readFileSync(destination,'utf8')==='local fixture only');
    if(toolName.startsWith('mcp__'))check(name+': MCP executed exactly once',state.mcpCalls===1);
    if(behavior==='before')check(name+': current turn uses updated mode without approval',state.callbacks.length===0);
    check(name+': synthetic provider only',state.requests.every(e=>e.authorized&&e.model==='fixture-model'));
    report.scenarios.push({name,callbacks:state.callbacks,requests:state.requests.length,mode:record.permissionMode,mcpCalls:state.mcpCalls});
  } finally { broker.close(); if(state.release)state.release();await session.kill(); }
}
(async()=>{
  server=http.createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
    if(req.url.includes('/count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":20}');return;}
    if(!req.url.includes('/messages')){res.writeHead(404);res.end('{}');return;}
    const body=JSON.parse(raw),state=active,index=state.requests.length;state.requests.push({model:body.model,authorized:req.headers['x-api-key']==='synthetic-priority-key'});
    if(!index){let sent=false;state.release=()=>{if(sent)return;sent=true;send(res,body,[state.tool]);};}
    else send(res,body,[{type:'text',text:'fixture completed'}]);
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/anthropic`;
  await scenario('before-edit','Write','acceptEdits',url,'before');
  await scenario('pending-edit','Write','acceptEdits',url);
  await scenario('pending-bash','Bash','bypassPermissions',url);
  await scenario('pending-mcp','mcp__relay-permission-fixture__echo','acceptEdits',url);
  await scenario('pending-question','AskUserQuestion','bypassPermissions',url);
  await scenario('narrow-default','Write','default',url,'narrow');
  report.ok=true;console.log(JSON.stringify({ok:true,checks:report.checks.length,scenarios:report.scenarios},null,2));
})().catch(error=>{report.ok=false;report.error=String(error.stack||error);report.failedScenario=active&&{name:active.name,callbacks:active.callbacks,requests:active.requests,results:active.results};console.error(report.error);process.exitCode=1;}).finally(async()=>{
  if(active?.session)await active.session.kill();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  let error;
  for(let i=0;i<30;i++){try{fs.rmSync(base,{recursive:true,force:true});error=null;break;}catch(e){error=e;await sleep(100);}}
  report.cleanedUp=!error;if(error){report.ok=false;report.cleanupError=String(error.code||error);process.exitCode=1;}
  fs.writeFileSync(path.join(output,'runtime-'+process.platform+'.json'),JSON.stringify(report,null,2));
});
