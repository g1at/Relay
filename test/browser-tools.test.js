'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserToolFactory } = require('../src/main/browser/browser-tools');
const sdk = { tool: (name, description, schema, run) => ({ name, description, schema, run }), createSdkMcpServer: options => options };

test('browser factory creates fresh servers with explicit bounded tools and dynamic trusted context', async () => {
  let context = { conversationId: 'one', runId: 'run-1' }; const calls = [];
  const factory = createBrowserToolFactory({ getContext: () => context, invoke: async (ctx, input) => { calls.push({ ctx, input }); return { ok: true, tabs: [] }; } });
  const first = factory(sdk)['relay-browser'], second = factory(sdk)['relay-browser'];
  assert.notEqual(first, second);
  assert.deepEqual(first.tools.map(tool => tool.name), ['tabs', 'open', 'navigate', 'focus', 'close', 'frames', 'observe', 'locate', 'act', 'verify', 'wait', 'diagnostics', 'upload', 'download', 'downloads', 'evidence', 'screenshot']);
  for (const tool of first.tools) assert.equal(Object.hasOwn(tool.schema, 'conversationId'), false);
  await first.tools[0].run({}); context = { conversationId: 'two', runId: 'run-2' }; await first.tools[0].run({});
  assert.equal(calls[0].ctx.runId, 'run-1'); assert.equal(calls[1].ctx.runId, 'run-2');
  assert.deepEqual(calls[1].input, { action: 'list' });
});

test('tool validation rejects injected context and arbitrary JavaScript before invoking the service', async () => {
  let calls = 0;
  const tools = createBrowserToolFactory({ getContext: () => ({}), invoke: async () => { calls++; return { ok: true }; } })(sdk)['relay-browser'].tools;
  const observe = tools.find(tool => tool.name === 'observe'), act = tools.find(tool => tool.name === 'act');
  assert.equal((await observe.run({ id: 'tab', conversationId: 'forged' })).isError, true);
  assert.equal((await act.run({ id: 'tab', kind: 'evaluate', observationId: 'o', code: 'process.exit()' })).isError, true);
  assert.equal((await act.run({ id: 'tab', kind: 'click', observationId: 'o' })).isError, true);
  assert.equal(calls, 0);
});

test('screenshots return MCP images without base64 in text and service denials remain MCP errors', async () => {
  let result = { ok: true, id: 'tab', data: 'cG5n', mimeType: 'image/png', url: 'https://example.test/' };
  const tools = createBrowserToolFactory({ getContext: () => ({}), invoke: async () => result })(sdk)['relay-browser'].tools;
  const screenshot = tools.find(tool => tool.name === 'screenshot');
  const response = await screenshot.run({ id: 'tab' });
  assert.deepEqual(response.content[1], { type: 'image', data: 'cG5n', mimeType: 'image/png' });
  assert.doesNotMatch(response.content[0].text, /cG5n/);
  result = { ok: false, code: 'PLAN_MODE_READ_ONLY', error: '只读' };
  const denied = await tools.find(tool => tool.name === 'open').run({ url: 'https://example.test/' });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /PLAN_MODE_READ_ONLY/);
});

test('extended tools reject unbounded waits, forged paths, malformed selects and value waits without refs', async () => {
  let calls = 0;
  const toolset = createBrowserToolFactory({ getContext: () => ({}), invoke: async () => { calls++; return { ok: true }; } })(sdk)['relay-browser'].tools;
  const run = (name, input) => toolset.find(tool => tool.name === name).run(input);
  for (const [name, input] of [
    ['wait', { id: 't', text: 'ready', timeoutMs: 30001 }],
    ['wait', { id: 't', value: 'ready' }],
    ['diagnostics', { id: 't', kind: 'body' }],
    ['upload', { id: 't', observationId: 'o', ref: 'e1', files: ['file'], workspaceRoot: '/' }],
    ['act', { id: 't', observationId: 'o', ref: 'e1', kind: 'select' }],
    ['download', { id: 't', observationId: 'o', ref: 'e1', directory: '/elsewhere' }],
  ]) assert.equal((await run(name, input)).isError, true, name);
  assert.equal(calls, 0);
  assert.equal((await run('act', { id: 't', observationId: 'o', ref: 'e1', kind: 'select', values: ['two'] })).isError, undefined);
  assert.equal(calls, 1);
});


test('complex tools validate semantic targets, frames, drag coordinates and navigation before dispatch', async () => {
  const calls=[];
  const tools=createBrowserToolFactory({getContext:()=>({conversationId:'trusted'}),invoke:async (_ctx,input)=>{calls.push(input);return {ok:true};}})(sdk)['relay-browser'].tools;
  const run=(name,input)=>tools.find(tool=>tool.name===name).run(input);
  for(const [name,input] of [
    ['locate',{id:'t',frameId:'f',locator:{role:'button',name:'Approve'}}],
    ['act',{id:'t',observationId:'o',kind:'drag',x:20,y:30,to:{x:80,y:90}}],
    ['act',{id:'t',observationId:'o',kind:'press',locator:{label:'Editor'},key:'Control+a'}],
    ['wait',{id:'t',locator:{text:'Approval ready'},state:'visible'}],
    ['navigate',{id:'t',kind:'back'}],
  ]) assert.equal((await run(name,input)).isError,undefined,name);
  assert.equal(calls.length,5);
  for(const [name,input] of [
    ['locate',{id:'t',locator:{}}], ['navigate',{id:'t',kind:'goto'}],
    ['act',{id:'t',observationId:'o',kind:'drag',x:20,y:30}],
    ['act',{id:'t',observationId:'o',kind:'click',x:20}],
    ['act',{id:'t',observationId:'o',kind:'click',ref:'e1',locator:{text:'wrong'}}],
  ]) assert.equal((await run(name,input)).isError,true,name);
  assert.equal(calls.length,5);
});

test('composed locators, assertions and atomic event waits reach the service without ambiguous conditions', async () => {
  const calls=[];
  const tools=createBrowserToolFactory({getContext:()=>({}),invoke:async (_ctx,input)=>{calls.push(input);return {ok:true};}})(sdk)['relay-browser'].tools;
  const run=(name,input)=>tools.find(tool=>tool.name===name).run(input);
  const locator={within:{role:'grid'},role:'row',has:{role:'gridcell',text:'Company 00002'},chain:[{role:'checkbox'}]};
  for(const [name,input] of [
    ['locate',{id:'t',locator}],
    ['verify',{id:'t',locator,checked:true,enabled:true,attribute:{name:'aria-label',value:null}}],
    ['verify',{id:'t',locator:{role:'row'},count:0}],
    ['wait',{id:'t',locator:{role:'textbox'},editable:true,value:'ready',timeoutMs:1000}],
    ['wait',{id:'t',event:'navigation',waitUntil:'load',url:'https://example.test/done'}],
    ['wait',{id:'t',event:'response',urlGlob:'**/saved',method:'POST',status:201}],
    ['act',{id:'t',observationId:'o',locator:{role:'button',name:'Save'},kind:'click',waitFor:{event:'response',urlGlob:'**/saved',method:'POST',status:201,timeoutMs:1000}}],
  ]) assert.equal((await run(name,input)).isError,undefined,JSON.stringify(input));
  assert.equal(calls.length,7); assert.deepEqual(calls[0].locator,locator);
  for(const [name,input] of [
    ['observe',{id:'t',scope:{}}],
    ['verify',{id:'t',enabled:true}],
    ['verify',{id:'t',ref:'r',observationId:'o',count:1}],
    ['verify',{id:'t',locator:{role:'button'}}],
    ['verify',{id:'t',ref:'r',checked:true}],
    ['wait',{id:'t',ref:'r',observationId:'o',state:'detached'}],
    ['wait',{id:'t',event:'response',locator:{role:'button'}}],
    ['wait',{id:'t',event:'navigation',status:200}],
    ['wait',{id:'t',event:'response',waitUntil:'load'}],
    ['wait',{id:'t',url:'done',method:'POST'}],
    ['act',{id:'t',observationId:'o',ref:'r',kind:'click',waitFor:{event:'response',body:'secret'}}],
    ['act',{id:'t',observationId:'o',ref:'r',kind:'click',waitFor:{event:'load',method:'POST'}}],
  ]) assert.equal((await run(name,input)).isError,true,JSON.stringify(input));
  assert.equal(calls.length,7);
});
