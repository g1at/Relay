'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const output = require('../renderer/assistant-output');
const conversationErrors = require('../renderer/conversation-errors');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const activitySource = fs.readFileSync(path.join(__dirname, '../renderer/activity-stream.js'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
function declaration(name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  assert.ok(match, `actual renderer function ${name} exists`);
  const tail = source.slice(match.index);
  const next = /\n(?:async )?function \w+\(/.exec(tail);
  let body = next ? tail.slice(0, next.index) : tail;
  // Never execute the app bootstrap listeners after the restore declaration.
  if (name === 'restoreActiveRunsFromLedger') body = body.split('\nvoid restoreActiveRunsFromLedger();')[0];
  return body;
}
// Actual renderer adapters and both reducers, with in-memory APIs only.
function harness(mode = 'plain', { mounted = false } = {}) {
  const timers = new Map(), rendered = [], notices = [], finalizations = [], updates = [];
  let timerId = 0, persisted;
  const turnTs = '2026-09-28T09:10:12.672Z';
  const conv = { id: 'conv', turns: [{ user: 'synthetic', runId: 'job', ts: turnTs }], kind: 'create', mode };
  const runs = new Map(), jobToConv = new Map();
  const context = {
    console, Map, Set, Date,
    window: { RelayTaskContinuity: require('../renderer/task-continuity'), RelayAssistantOutput: output, RelayConversationErrors: conversationErrors, api: { history: {
      load: async () => persisted || conv,
      save: async (value) => { persisted = clone(value); return { updatedAt: 'synthetic-time' }; },
      recoverTurn: async () => ({ ok: false, error: 'synthetic original input unavailable' }),
      completeTurn: async (id, runId, ts, payload) => {
        const next = clone(persisted || conv);
        const index = next.turns.findIndex(turn => turn.runId === runId && turn.ts === ts);
        if (next.id !== id || index < 0) return { error: 'turn identity mismatch' };
        if (payload.retryWithoutResume) {
          if (next.turns[index].assistant) return { error: 'turn already has an answer' };
          next.turns.splice(index, 1); next.sessionId = null;
        } else {
          Object.assign(next.turns[index], clone(payload.turn));
          if (payload.session) Object.assign(next, clone(payload.session));
          if (payload.paused) next.paused = clone(payload.paused);
          if (payload.clearPausedRunId && next.paused?.runId === payload.clearPausedRunId) delete next.paused;
          if (payload.clearCarryContextReason === next.carryContextOnNextTurn) delete next.carryContextOnNextTurn;
        }
        next.updatedAt = 'synthetic-time'; persisted = next;
        return { id, updatedAt: next.updatedAt, conversation: clone(next) };
      },
    } } },
    runForJob: (id) => runs.get(jobToConv.get(id)), isMountedChatJob: () => mounted,
    runs, jobToConv, currentConv: conv, currentAssistantBubble: null, currentSessionId: null,
    activeView: mounted ? 'chat' : 'settings', pendingConversationViewReloads: new Set(),
    updateRunActivity(run, onView, force) { updates.push({ run, onView, force }); },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    appendOrUpdateAssistant: (text) => rendered.push(text),
    renderRunOutput: (run) => { if (run.outputState && run.outputState.status === 'complete' && run.outputState.final) rendered.push(run.outputState.final); },
    appendMessage: (role, text) => { notices.push({ role, text }); },
    flushStreamRender() {}, removeThinking() {}, hasImageAttachment: () => false,
    setRunning() {}, appendMessageTime() {}, refreshHistoryList: async () => {},
    refreshClaudeRuntimeInfo: async () => {}, maybeGenerateTitle() {}, maybeAutoReviewSkills() {},
    finishRun: (jobId, event) => { finalizations.push({ jobId, event }); },
  };
  vm.createContext(context);
  vm.runInContext(activitySource, context, { filename: 'activity-stream.js' });
  for (const name of [
    'newActivityState', 'activityStateForTurn', 'activityOutputItems', 'outputStateForRun',
    'syncRunOutputActivity', 'scheduleRunOutputActivity', 'activityEventNeedsRender',
    'hasSupplementTimeline', 'showRunError',
    'permissionDenialMessage', 'savedAssistantDisplay', 'activityEventsForClaudeEvent',
    'handleClaudeEvent', 'isFirstLogicalTask', 'taskSource', 'taskTurnLocation', 'finishRunUnsafe',
  ]) vm.runInContext(declaration(name), context, { filename: `app.js:${name}` });
  const run = {
    jobId: 'job', convId: 'conv', mode, turnIndex: 0,
    turn: { user: 'synthetic', runId: 'job', ts: turnTs, assistant: '', thinkingList: [], files: [], chat: [] },
    activityState: context.newActivityState(), stderrBuf: '', sessionId: null,
  };
  runs.set('conv', run); jobToConv.set('job', 'conv');
  return {
    run, conv, context, timers, rendered, notices, finalizations, updates, output,
    get persisted() { return persisted; },
    send(event) { context.handleClaudeEvent({ jobId: 'job', ...event }); },
    flush() { context.syncRunOutputActivity(context.runForJob('job'), mounted); },
    loadFunction(name) { vm.runInContext(declaration(name), context, { filename: `app.js:${name}` }); },
  };
}
const result = (text, extra = {}) => ({ type: 'result', subtype: 'success', result: text, ...extra });
const full = (id, text, extra = {}) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text }] }, ...extra });
const stream = (event, extra = {}) => ({ type: 'stream_event', event, ...extra });
const notification = (status = 'completed', text = 'child result', extra = {}) => ({
  type: 'user', uuid: 'legacy-notification', message: { content: '<task-notification>\n'
    + '<task-id>task-child</task-id><tool-use-id>parent</tool-use-id>'
    + (status == null ? '' : `<status>${status}</status>`)
    + `<summary>synthetic summary</summary><result>${text}</result>\n</task-notification>` }, ...extra,
});
module.exports = { harness, declaration, source, clone, result, full, stream, notification };
