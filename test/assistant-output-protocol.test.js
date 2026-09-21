'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const output = require('../renderer/assistant-output');

// Frozen pre-optimization parser is an independent compatibility oracle for the
// protocol boundary rules. Keep it out of production and use short test inputs.
  function legacySplitProtocol(value) {
    const source = String(value || '');
    const lines = source.split(/(?<=\n)/);
    let offset = 0, fence = null;
    const ranges = [];
    for (const line of lines) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      }
      if (!fence && !marker && !/^\s*>|^ {4}|^\t/.test(line)) {
        const tail = source.slice(offset);
        const match = tail.match(/^ {0,3}<(tool_call|function_calls|tool_calls)>\s*<(?:function\s*=|invoke\s+(?:name|tool)=|tool_call>)/i);
        const introducedExample = /[:：]\s*$/.test(source.slice(0, offset).trimEnd());
        if (match && !introducedExample && !ranges.some((range) => offset < range.end)) {
          const close = new RegExp('</' + match[1] + '\\s*>', 'i').exec(tail.slice(match[0].length));
          const end = close ? offset + match[0].length + close.index + close[0].length : source.length;
          ranges.push({ start: offset, end });
        }
      }
      offset += line.length;
    }
    let text = '', cursor = 0;
    const diagnostics = [];
    for (const range of ranges) {
      text += source.slice(cursor, range.start);
      diagnostics.push(source.slice(range.start, range.end));
      cursor = range.end;
    }
    text += source.slice(cursor);
    return { text: ranges.length ? text.trim() : source, diagnostics };
  }


const tool = '<tool_call><function=Read><parameter=file_path>example.txt</parameter></function></tool_call>';
const variants = [tool,
  '<function_calls>\n<invoke name="Read">x</invoke>\n</function_calls>',
  '<tool_calls>\n<tool_call><invoke tool="Read">x</invoke></tool_call>\n</tool_calls>',
  '   <TOOL_CALL>\r\n<function = Read>raw</function>\r\n</TOOL_CALL  >'];

test('linear protocol scan matches existing boundaries through all stream prefixes', () => {
  const documents = variants.flatMap(protocol => [
    'before\n\n' + protocol + '\n\nafter',
    'example：\n\n  \t\n' + protocol,
    '```xml\n' + protocol + '\n```\n' + protocol,
    '~~~~xml\n' + protocol + '\n~~~\n' + protocol + '\n~~~~\n' + protocol,
    '> ' + protocol + '\n    ' + protocol + '\n\t' + protocol,
    'intro\n' + protocol + '\n' + protocol + '\nend',
  ]);
  let checked = 0;
  for (const source of documents) for (let length = 0; length <= source.length; length++) {
    const prefix = source.slice(0, length);
    assert.deepEqual(output.splitProtocol(prefix), legacySplitProtocol(prefix));
    checked++;
  }
  assert.ok(checked > 3000);
});

test('protocol diagnostics preserve every source byte across multiline and partial closing tags', () => {
  for (const protocol of variants) {
    const source = 'kept\n\n' + protocol + '\n\nafter';
    assert.deepEqual(output.splitProtocol(source).diagnostics, [protocol]);
    assert.equal(output.splitProtocol(source).text, 'kept\n\n\n\nafter');
  }
  for (const protocol of ['<tool_call><function=Read>half', '<tool_calls>\n<tool_call>half', '<function_calls><invoke name="Read">half']) {
    assert.deepEqual(output.splitProtocol('before\n' + protocol), { text: 'before', diagnostics: [protocol] });
  }
});

test('ordinary JSON, code, XML and colon-introduced examples remain unchanged', () => {
  const sources = ['{"type":"tool_call","input":{"value":"x"}}',
    '```json\n{"type":"tool_call","text":"' + tool + '"}\n```',
    'const text = "' + tool + '";\nconst expression = /[(\\s*)]+/g;',
    '<tool_call>ordinary XML content</tool_call>', '<function_calls>explanation</function_calls>',
    '3 spaces：\n \n   ' + tool, 'Unicode spaces:\u00a0\n\u2003\n' + tool,
    'inline ' + tool, '    ' + tool, '\t' + tool, '> ' + tool,
    '~~~xml\n' + tool + '\n~~~'];
  for (const source of sources) assert.deepEqual(output.splitProtocol(source), { text: source, diagnostics: [] });
});

test('live preview withholds partial standalone openers and never promotes diagnostics', () => {
  for (const opener of ['<tool_call>', '<tool_calls>', '<function_calls>']) {
    for (let length = 1; length <= opener.length; length++) {
      const text = 'safe\n' + opener.slice(0, length);
      assert.equal(output.visibleText(text, false), 'safe\n');
      const state = output.createState();
      output.ingest(state, { type: 'assistant', message: { id: 'live', content: [{ type: 'text', text }] } });
      assert.deepEqual(output.preview(state), { messageId: 'live', text: 'safe\n' });
    }
  }
  const state = output.createState();
  output.ingest(state, { type: 'assistant', message: { id: 'live', content: [{ type: 'text', text: 'safe\n' + tool }] } });
  assert.equal(output.preview(state), null);
  assert.equal(output.processItems(state)[0].type, 'diagnostic');
  assert.equal(output.processItems(state)[0].result, 'safe\n' + tool);
});

test('long Markdown protocol filtering stays within the streaming frame budget', t => {
  const section = '## 章节标题\n\n普通 Markdown 中有括号(x + y)、转义\\path\\image以及行内const声明。\n\n- 第一项：检查交付文件\n- 第二项：继续输出说明文字\n\n```js\nconst item = {pattern: /[a-z]+\\s*/g, call: (x) => x + 1};\n```\n\n';
  const source = section.repeat(Math.ceil(240000 / section.length));
  output.splitProtocol(source); // JIT warmup is separate from measured calls.
  const samples = [];
  for (let sample = 0; sample < 3; sample++) {
    const started = performance.now();
    for (let iteration = 0; iteration < 2; iteration++) {
      const filtered = output.splitProtocol(source);
      assert.equal(filtered.text, source); assert.equal(filtered.diagnostics.length, 0);
    }
    samples.push(performance.now() - started);
  }
  const fastest = Math.min(...samples);
  t.diagnostic(JSON.stringify({ characters: source.length, lines: source.split('\n').length, callsPerSample: 2, samplesMs: samples }));
  // The old quadratic prefix scan takes seconds for this workload. A generous
  // ceiling allows slow CI; interactive Electron frame pacing is tested separately.
  assert.ok(fastest < 250, `protocol filtering took ${fastest.toFixed(1)}ms`);
});
