'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { modelName, describeRoute, effortVisualState } = require('../renderer/model-display');

test('model names retain only the final namespace component and preserve model options', () => {
  assert.equal(modelName('xiaomi/mimo-x-pro-preview'), 'mimo-x-pro-preview');
  assert.equal(modelName('ppio/pa/claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(modelName(' xiaomi/mimo-v2.5-pro[1m] '), 'mimo-v2.5-pro[1m]');
  assert.equal(modelName('standalone-model'), 'standalone-model');
  assert.equal(modelName(''), '');
});

test('route display is authoritative when a cached SDK name disagrees', () => {
  const route = {
    providerName: 'Mify', modelId: 'xiaomi/mimo-x-pro-preview',
    displayName: 'ppio/pa/claude-opus-4-8',
  };
  const display = describeRoute(route);
  assert.equal(display.label, 'mimo-x-pro-preview');
  assert.equal(display.tooltip, display.label);
  assert.equal(display.modelId, 'xiaomi/mimo-x-pro-preview');
  assert.doesNotMatch(display.tooltip, /Mify|ppio|claude/);
});

test('changing routes refreshes every display field without borrowing old capability labels', () => {
  const initial = describeRoute({ modelId: 'provider/first-model' });
  const updated = describeRoute({ modelId: 'other/vendor/second-model' });
  assert.equal(initial.tooltip, 'first-model');
  assert.equal(updated.label, 'second-model');
  assert.equal(updated.tooltip, 'second-model');
});

test('missing and not-yet-loaded routes are explicit rather than showing an SDK alias', () => {
  assert.deepEqual(describeRoute(null), {
    modelId: '', label: '未配置模型', tooltip: '未配置模型', configured: false,
  });
  assert.equal(describeRoute(null, { loaded: false }).label, '正在加载模型');
});

test('compact composer tier label keeps the real configured model in its tooltip and expanded menu', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  class Element {
    constructor() { this.children = []; this.attributes = {}; this.handlers = {}; }
    appendChild(child) { this.children.push(child); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
  }
  const tier = { value: 'opus', label: '专家', icon: '<svg></svg>' };
  const route = { providerName: 'Mify', modelId: 'xiaomi/mimo-x-pro-preview' };
  const context = {
    window: { RelayModelDisplay: { describeRoute } },
    document: { createElement() { return new Element(); } },
    configuredChatRoute() { return route; }, currentTier() { return tier; },
    providerRoutingLoaded: true, currentModel: 'opus', MODEL_TIERS: [tier],
    modelCapability() { return { displayName: 'ppio/pa/claude-opus-4-8' }; },
    effectiveEffortForTier() { return 'max'; }, EFFORT_LABELS: { max: '最大' },
    msIco: new Element(), msLabel: new Element(), msEffortLabel: new Element(), btnModelSwitch: new Element(),
    escapeHtml: (value) => value,
    appendModelSubmenuHead() {}, selectModelTier() {},
  };
  const displayStart = source.indexOf('function modelDisplayForTier(');
  const displayStop = source.indexOf('function fullTokenCount(', displayStart);
  const menuStart = source.indexOf('function renderModelPopupModels(');
  const menuStop = source.indexOf('function renderModelPopupAdvanced(', menuStart);
  vm.runInNewContext(`${source.slice(displayStart, displayStop)}\n${source.slice(menuStart, menuStop)}`, context);
  const menu = new Element();
  context.updateModelSwitchUI();
  context.renderModelPopupModels(menu);
  assert.equal(context.msLabel.textContent, '专家');
  assert.equal(context.btnModelSwitch.title, 'mimo-x-pro-preview');
  assert.equal(menu.children[0].title, context.btnModelSwitch.title);
  assert.match(menu.children[0].innerHTML, /class="mp-desc">mimo-x-pro-preview<\/span>/);
  assert.doesNotMatch(menu.children[0].innerHTML, /Mify|xiaomi\/|ppio|claude/);
});

test('effort animation positions follow only the levels actually supported by the model', () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(effortVisualState(levels, 0), { index: 0, level: 'low', fraction: 0 });
  assert.deepEqual(effortVisualState(levels, 2), { index: 2, level: 'high', fraction: .5 });
  assert.deepEqual(effortVisualState(levels, 4), { index: 4, level: 'max', fraction: 1 });
  assert.deepEqual(effortVisualState(['low', 'high'], 1), { index: 1, level: 'high', fraction: 1 });
  assert.deepEqual(effortVisualState([], 8), { index: 0, level: null, fraction: 0 });
  assert.deepEqual(effortVisualState(['high'], 2), { index: 0, level: 'high', fraction: 1 });
});
