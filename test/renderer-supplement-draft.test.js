'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

function fixture() {
  const sent = [], receipts = [], toasts = [];
  const ctx = vm.createContext({
    currentConv: { id: 'chat', turns: [{ runId: 'old-run', assistant: 'Final answer', supplements: [] }] },
    inputEl: { value: '' }, attachedFiles: [], selectedQuickSkill: null,
    supplementDrafts: new Map(), composerDrafts: new Map(), composerDraftOwner: {}, conversationControls: new Map(), runs: new Map(), isRunning: false,
    activeView: 'settings', btnModelSwitch: {}, conversationControlNote: { hidden: true, textContent: '' },
    getProjectComposer: () => null, syncComposerAction() {}, syncMcpReconnectButtons() {}, syncPermissionControl() {}, syncContextUsagePolling() {},
    renderAttachments() {}, hideSkillQuickPopup() {}, autoGrowInput() {}, scrollToBottom() {},
    isConvRunning: () => false, isMountedChatJob: () => false, newClientRunId: () => 'new-id',
    showToast: message => toasts.push(message),
    send: async payload => { sent.push(payload); return { ok: true }; },
    window: { api: { steerClaude: async payload => { receipts.push(payload); return { ok: false, code: 'UNKNOWN' }; } } },
  });
  ctx.setSelectedQuickSkill = value => { ctx.selectedQuickSkill = value; };
  for (const [start, end] of [
    ['function readComposerDraft(', 'function syncComposerAction('],
    ['async function submitSupplement(', 'function appendSupplementMessage('],
    ['function applyRunSupplement(', 'async function steerCurrent('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), ctx);
  const draft = patch => ({ jobId: 'old-run', messageId: 'input-id', prompt: 'Retained requirement', files: [], skill: null, ...patch });
  return { ctx, draft, sent, receipts, toasts };
}

test('paused confirmed-undelivered content becomes an ordinary draft with no retry row', () => {
  const h = fixture(), draft = h.draft({ sendAsNew: true, files: [{ path: '/fixture/input.txt', name: 'input.txt' }], skill: { name: 'review' } });
  h.ctx.currentConv.paused = { runId: 'old-run' }; h.ctx.supplementDrafts.set('chat', draft);
  h.ctx.setRunning(false);
  assert.equal(h.ctx.inputEl.value, draft.prompt);
  assert.equal(h.ctx.attachedFiles[0].path, '/fixture/input.txt');
  assert.equal(h.ctx.selectedQuickSkill.name, 'review');
  assert.equal(h.ctx.supplementDrafts.has('chat'), false);
  assert.equal(h.ctx.conversationControlNote.hidden, true);
  assert.equal(h.ctx.conversationControlNote.textContent, '');
  assert.equal(h.sent.length, 0);
});

test('a late canceled supplement preserves a newer text, file and skill draft', () => {
  const h = fixture(); h.ctx.inputEl.value = 'Newer draft'; h.ctx.attachedFiles = [{ path: '/newer.txt' }]; h.ctx.selectedQuickSkill = { name: 'newer' };
  const run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
  h.ctx.applyRunSupplement(run, { id: 'canceled-id', status: 'canceled', text: 'Not consumed', files: [] });
  assert.equal(h.ctx.inputEl.value, 'Newer draft'); assert.equal(h.ctx.attachedFiles[0].path, '/newer.txt');
  assert.equal(h.ctx.selectedQuickSkill.name, 'newer');
  assert.equal(h.ctx.supplementDrafts.get('chat').prompt, 'Not consumed');
  assert.equal(run.turn.supplements[0].status, 'canceled');
});

test('repeated canceled delivery frames never recreate an already recovered draft', () => {
  const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
  const input = { id: 'canceled-id', status: 'canceled', text: 'Not consumed', files: [] };
  h.ctx.applyRunSupplement(run, input);
  assert.equal(h.ctx.inputEl.value, input.text); assert.equal(h.ctx.supplementDrafts.size, 0);
  h.ctx.inputEl.value = '';
  h.ctx.applyRunSupplement(run, input);
  assert.equal(h.ctx.inputEl.value, ''); assert.equal(h.ctx.supplementDrafts.size, 0);
  assert.equal(run.turn.supplements.length, 1); assert.equal(run.turn.supplements[0].status, 'canceled');
});

test('host delivery correction wins over an earlier cancellation and ignores late queue or cancel frames', () => {
  const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
  run.turn.supplements = [{ id: 'input-id', status: 'canceled', text: 'Delivered before task stopped', files: [] }];
  h.ctx.applyRunSupplement(run, { ...run.turn.supplements[0], status: 'applied' });
  for (const status of ['queued', 'canceled', 'rejected']) {
    h.ctx.applyRunSupplement(run, { ...run.turn.supplements[0], status });
    assert.equal(run.turn.supplements[0].status, 'applied');
  }
  assert.equal(h.ctx.supplementDrafts.size, 0); assert.equal(h.sent.length, 0);
});

test('actual cancellation followed by delivery clears only its unchanged recovered composer draft', () => {
  const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
  const input = { id: 'input-id', status: 'canceled', text: 'Delivered supplement',
    files: [{ path: '/fixture/input.txt' }], skill: { name: 'fixture' } };
  h.ctx.applyRunSupplement(run, input);
  assert.equal(h.ctx.inputEl.value, input.text); assert.equal(h.ctx.supplementDrafts.size, 0);
  assert.equal(h.ctx.composerDraftOwner.supplementSource.sourceMessageId, input.id);
  assert.equal(h.ctx.composerDraftOwner.supplementSource.jobId, run.jobId);
  h.ctx.applyRunSupplement(run, { ...input, status: 'applied' });
  for (const status of ['queued', 'canceled', 'rejected']) h.ctx.applyRunSupplement(run, { ...input, status });
  assert.equal(run.turn.supplements[0].status, 'applied'); assert.equal(h.ctx.inputEl.value, '');
  assert.equal(h.ctx.attachedFiles.length, 0); assert.equal(h.ctx.selectedQuickSkill, null);
  assert.equal(h.ctx.composerDraftOwner.supplementSource, undefined);
  assert.equal(h.ctx.supplementDrafts.size, 0); assert.equal(h.sent.length, 0);
});

for (const [name, edit] of [
  ['text', h => { h.ctx.inputEl.value = 'User replacement'; }],
  ['whitespace', h => { h.ctx.inputEl.value += ' '; }],
  ['files', h => { h.ctx.attachedFiles.push({ path: '/fixture/new.txt' }); }],
  ['skill', h => { h.ctx.selectedQuickSkill = { name: 'different' }; }],
]) {
  test(`delivery correction preserves recovered content after a user edits ${name}`, () => {
    const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
    const input = { id: 'input-id', status: 'canceled', text: 'Delivered supplement',
      files: [{ path: '/fixture/input.txt' }], skill: { name: 'fixture' } };
    h.ctx.applyRunSupplement(run, input);
    edit(h);
    const edited = JSON.stringify(h.ctx.readComposerDraft());
    h.ctx.captureComposerDraft();
    assert.equal(h.ctx.composerDraftOwner.supplementSource, undefined);
    h.ctx.applyRunSupplement(run, { ...input, status: 'applied' });
    assert.equal(JSON.stringify(h.ctx.readComposerDraft()), edited);
    assert.equal(h.sent.length, 0);
  });
}

test('editing then restoring the same text does not restore automatic draft ownership', () => {
  const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
  const input = { id: 'input-id', status: 'canceled', text: 'Original supplement', files: [] };
  h.ctx.applyRunSupplement(run, input);
  h.ctx.inputEl.value = 'Edited'; h.ctx.captureComposerDraft();
  h.ctx.inputEl.value = input.text;
  h.ctx.applyRunSupplement(run, { ...input, status: 'applied' });
  assert.equal(h.ctx.inputEl.value, input.text); assert.equal(h.sent.length, 0);
});

test('delivery removes a canceled draft with a new retry id while preserving a newer composer', () => {
  const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
  h.ctx.inputEl.value = 'New user draft'; h.ctx.attachedFiles = [{ path: '/new.txt' }]; h.ctx.selectedQuickSkill = { name: 'new' };
  const newer = JSON.stringify(h.ctx.readComposerDraft());
  const input = { id: 'input-id', status: 'canceled', text: 'Delivered supplement', files: [] };
  h.ctx.applyRunSupplement(run, input);
  const retry = h.ctx.supplementDrafts.get('chat');
  assert.notEqual(retry.messageId, input.id); assert.equal(retry.sourceMessageId, input.id);
  h.ctx.applyRunSupplement(run, { ...input, status: 'applied' });
  assert.equal(h.ctx.supplementDrafts.size, 0); assert.equal(JSON.stringify(h.ctx.readComposerDraft()), newer);
  assert.equal(h.sent.length, 0);
});

test('canceling an uncertain send preserves its original source through retry-id conversion and composer recovery', () => {
  const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
  const draft = h.draft(); h.ctx.supplementDrafts.set('chat', draft);
  const input = { id: draft.messageId, status: 'canceled', text: draft.prompt, files: [] };
  h.ctx.applyRunSupplement(run, input);
  assert.notEqual(draft.messageId, input.id); assert.equal(draft.sourceMessageId, input.id);
  h.ctx.setRunning(false);
  assert.equal(h.ctx.inputEl.value, draft.prompt); assert.equal(h.ctx.supplementDrafts.size, 0);
  h.ctx.applyRunSupplement(run, { ...input, status: 'applied' });
  assert.equal(h.ctx.inputEl.value, ''); assert.equal(h.sent.length, 0);
});

test('delivery cannot remove an explicitly edited retry draft sharing the original source id', () => {
  const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
  h.ctx.inputEl.value = 'Existing draft';
  const input = { id: 'input-id', status: 'canceled', text: 'Delivered supplement', files: [] };
  h.ctx.applyRunSupplement(run, input);
  const retry = h.ctx.supplementDrafts.get('chat'); retry.prompt = 'Edited retry';
  h.ctx.applyRunSupplement(run, { ...input, status: 'applied' });
  assert.equal(h.ctx.supplementDrafts.get('chat'), retry); assert.equal(retry.prompt, 'Edited retry');
  assert.equal(h.ctx.inputEl.value, 'Existing draft');
});

test('delivery corrections cannot clear another run or conversation even with equal text and input ids', () => {
  for (const extra of [{ jobId: 'other-run' }, { convId: 'other-chat' }]) {
    const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
    const input = { id: 'input-id', status: 'canceled', text: 'Same text', files: [] };
    h.ctx.applyRunSupplement(run, input);
    h.ctx.applyRunSupplement({ ...run, ...extra, turn: { runId: 'other-run', supplements: [] } }, { ...input, status: 'applied' });
    assert.equal(h.ctx.inputEl.value, input.text);
    assert.equal(h.ctx.composerDraftOwner.supplementSource.jobId, run.jobId);
    assert.equal(h.sent.length, 0);
  }
});

test('offscreen correction clears only its unchanged saved owner and keeps the current chat draft', () => {
  for (const edited of [false, true]) {
    const h = fixture(), run = { jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] };
    const input = { id: 'input-id', status: 'canceled', text: 'Same text', files: [] };
    h.ctx.applyRunSupplement(run, input);
    if (edited) h.ctx.inputEl.value = 'Edited original chat';
    h.ctx.bindComposerDraft('chat'); h.ctx.activateComposerDraft('other'); h.ctx.currentConv = { id: 'other', turns: [] };
    h.ctx.inputEl.value = input.text;
    h.ctx.applyRunSupplement(run, { ...input, status: 'applied' });
    assert.equal(h.ctx.inputEl.value, input.text, 'never clears the foreground chat');
    assert.equal(h.ctx.composerDrafts.get('chat').prompt, edited ? 'Edited original chat' : '');
    assert.equal(h.ctx.composerDrafts.get('chat').supplementSource, undefined);
    assert.equal(h.sent.length, 0);
  }
});

test('normal composer retry reconciles an uncertain receipt against the old run without resending', async () => {
  const h = fixture(), draft = h.draft(); h.ctx.supplementDrafts.set('chat', draft); h.ctx.setRunning(false);
  h.ctx.window.api.steerClaude = async payload => { h.receipts.push(payload); return { ok: true, input: { id: 'input-id', status: 'applied', text: draft.prompt } }; };
  const result = await h.ctx.submitComposerSupplement(draft, 'chat');
  assert.equal(result.ok, true); assert.equal(h.receipts[0].jobId, 'old-run'); assert.equal(h.receipts[0].messageId, 'input-id');
  assert.equal(h.sent.length, 0); assert.equal(h.ctx.inputEl.value, ''); assert.equal(h.ctx.supplementDrafts.size, 0);
  assert.equal(h.ctx.currentConv.turns[0].assistant, 'Final answer');
});

test('unconfirmed receipt failure keeps the same input identity and restores composer content', async () => {
  const h = fixture(), draft = h.draft(); h.ctx.supplementDrafts.set('chat', draft); h.ctx.setRunning(false);
  const result = await h.ctx.submitComposerSupplement(draft, 'chat');
  assert.equal(result.ok, false); assert.equal(h.ctx.supplementDrafts.get('chat'), draft);
  assert.equal(draft.messageId, 'input-id'); assert.equal(h.ctx.inputEl.value, draft.prompt);
  assert.equal(h.ctx.conversationControlNote.hidden, true); assert.equal(h.sent.length, 0);
});

test('definitive refusal transfers content to normal sending and never starts a turn automatically', async () => {
  const h = fixture(), draft = h.draft(); h.ctx.supplementDrafts.set('chat', draft); h.ctx.setRunning(false);
  h.ctx.window.api.steerClaude = async () => ({ ok: false, code: 'NOT_RUNNING' });
  await h.ctx.submitComposerSupplement(draft, 'chat');
  assert.equal(h.ctx.inputEl.value, draft.prompt); assert.equal(h.ctx.supplementDrafts.size, 0); assert.equal(h.sent.length, 0);
});

test('late acceptance consumes only the unchanged recovered composer draft', () => {
  for (const edited of [false, true]) {
    const h = fixture(), draft = h.draft(); h.ctx.supplementDrafts.set('chat', draft); h.ctx.setRunning(false);
    if (edited) h.ctx.inputEl.value = 'User typed something newer';
    h.ctx.applyRunSupplement({ jobId: 'old-run', convId: 'chat', turnIndex: 0, turn: h.ctx.currentConv.turns[0] },
      { id: 'input-id', status: 'applied', text: draft.prompt });
    assert.equal(h.ctx.supplementDrafts.size, 0);
    assert.equal(h.ctx.inputEl.value, edited ? 'User typed something newer' : '');
  }
});

test('switching conversations keeps uncertain recovered input attached to its original run', () => {
  for (const edited of [false, true]) {
    const h = fixture(), draft = h.draft(); h.ctx.supplementDrafts.set('chat', draft); h.ctx.setRunning(false);
    if (edited) h.ctx.inputEl.value = 'Unrelated new draft';
    h.ctx.bindComposerDraft('chat');
    h.ctx.activateComposerDraft('other'); h.ctx.currentConv = { id: 'other', turns: [] }; h.ctx.setRunning(false);
    assert.equal(h.ctx.supplementDrafts.get('chat'), draft); assert.equal(draft.messageId, 'input-id');
    assert.equal(h.ctx.inputEl.value, '');
    h.ctx.activateComposerDraft('chat'); h.ctx.currentConv = { id: 'chat', turns: [] }; h.ctx.setRunning(false);
    assert.equal(h.ctx.inputEl.value, edited ? 'Unrelated new draft' : draft.prompt);
  }
});
