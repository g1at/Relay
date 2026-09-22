'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/interaction-surface.js'), 'utf8');
const start = source.indexOf('  function collectAnswers(');
const end = source.indexOf('  async function respond(', start);
const question = (text, multiSelect = false) => ({ question: text, multiSelect });

function fixture(values) {
  const focused = [];
  const errors = [];
  const fieldsets = values.map((value, index) => {
    const selected = (value.selected || []).map((label) => ({ value: label }));
    const input = { focus() { focused.push(index); } };
    const otherText = { value: value.other || '', focus() { focused.push(index); } };
    return {
      index,
      querySelectorAll() { return selected; },
      querySelector(selector) {
        if (selector === 'input[data-other-choice]') return { checked: !!value.otherSelected };
        if (selector === '.interaction-other-input') return otherText;
        return input;
      },
    };
  });
  const context = { showFieldError(fieldset, message) { errors.push({ index: fieldset.index, message }); } };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.collect = collectAnswers;`, context);
  const form = { querySelectorAll() { return fieldsets; } };
  return { collect: (questions, options) => context.collect(form, questions, options), focused, errors };
}

test('a question page validates only its own answer before moving forward', () => {
  const current = fixture([{ selected: ['本地'] }, {}]);
  const answers = current.collect([question('在哪里运行？'), question('何时运行？')], { onlyIndex: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), { '在哪里运行？': '本地' });
  assert.deepEqual(current.errors, []);
  assert.deepEqual(current.focused, []);
});

test('final submission reveals the earliest unanswered page before moving keyboard focus', () => {
  const current = fixture([{}, { selected: ['稍后'] }]);
  const shown = [];
  const answers = current.collect([question('在哪里运行？'), question('何时运行？')], {
    onInvalid(index) { shown.push(index); assert.equal(current.focused.length, 0); },
  });
  assert.equal(answers, null);
  assert.deepEqual(shown, [0]);
  assert.deepEqual(current.focused, [0]);
  assert.equal(current.errors.length, 1);
});

test('all pages submit the original question keys and preserve multi-select plus free text', () => {
  const current = fixture([
    { selected: ['搜索', '文件'], otherSelected: true, other: '  补充说明  ' },
    { otherSelected: true, other: '明天' },
  ]);
  const answers = current.collect([question('要使用什么？', true), question('何时运行？')]);
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), {
    '要使用什么？': ['搜索', '文件', '补充说明'],
    '何时运行？': '明天',
  });
});

test('choosing other requires actual text even when a separate multi-select option is checked', () => {
  const current = fixture([{ selected: ['搜索'], otherSelected: true, other: '   ' }]);
  assert.equal(current.collect([question('要使用什么？', true)]), null);
  assert.match(current.errors[0].message, /具体内容/);
  assert.deepEqual(current.focused, [0]);
});
