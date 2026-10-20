'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { annotateError, errorCategory } = require('../src/main/sdk/sdk-error-categories');
const message = "API Error: 400 Invalid request: ***.***.parameters is not a valid moonshot flavored json schema, details: <At path '***.actions': detected infinite recursion without termination condition> (request id: synthetic-401-429)";
test('Moonshot schema rejection takes precedence over digits in the request id', () => {
 assert.equal(errorCategory(message), 'tool_schema_incompatible');
 assert.equal(errorCategory('HTTP 401 invalid api key'), 'authentication');
 assert.equal(errorCategory('HTTP 429 rate limit'), 'rate_limit');
 assert.equal(errorCategory('HTTP 400 Invalid request: unknown model'), null);
 assert.equal(errorCategory('Autocompact is thrashing'), 'context_compaction_loop');
});
test('SDK API assistant error is identified without replacing original text or identity', () => {
 const event = {type:'assistant',error:'unknown',isApiErrorMessage:true,uuid:'message-1',session_id:'session-1',message:{content:[{type:'text',text:message}]}};
 const before = structuredClone(event);const output = annotateError(event);
 assert.equal(output.relay_error_category, 'tool_schema_incompatible');
 assert.match(output.relay_error_description, /参数格式/);
 assert.match(output.relay_error_suggestion, /原样重试/);
 assert.equal(output.message, event.message);assert.equal(output.uuid,'message-1');assert.equal(output.session_id,'session-1');
 assert.deepEqual(event,before);
});
test('native success subtype with is_error true remains a failed schema result', () => {
 const event={type:'result',subtype:'success',is_error:true,api_error_status:400,terminal_reason:'api_error',result:message,session_id:'session-1',uuid:'result-1',usage:{input_tokens:1}};
 const output=annotateError(event);
 assert.equal(output.relay_error_category,'tool_schema_incompatible');
 assert.equal(output.is_error,true);assert.equal(output.subtype,'success');assert.equal(output.result,message);
 assert.deepEqual(output.usage,{input_tokens:1});assert.equal(output.uuid,'result-1');
});
test('successful discussion quoting an error and advisory events are not relabeled', () => {
 const result=annotateError({type:'result',subtype:'success',is_error:false,result:message});
 assert.equal(result.relay_error_category,undefined);
 const assistant=annotateError({type:'assistant',message:{content:[{type:'text',text:message}]}});
 assert.equal(assistant.relay_error_category,undefined);
 const system=annotateError({type:'system',subtype:'warning',error:message});
 assert.equal(system.relay_error_category,undefined);
});
