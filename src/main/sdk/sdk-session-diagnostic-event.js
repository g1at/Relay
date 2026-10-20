'use strict';

const { diagnosticsFromEvent, mergeDiagnostics, hasDiagnostics } = require('./sdk-diagnostic-details');

// Called only after the live turn router has accepted this result. Preserve
// host measurements with the result itself, before the UI retires the run;
// a later runtimeInfo request may already belong to another turn.
function withSessionDiagnostics(event, snapshot) {
  if (!event || event.type !== 'result' || !snapshot
      || event.parent_tool_use_id || event.parentToolUseId || event.agent_id || event.subagent_type
      || snapshot.sessionId && event.session_id && snapshot.sessionId !== event.session_id
      || Number.isSafeInteger(event.context_epoch) && Number.isSafeInteger(snapshot.epoch) && event.context_epoch !== snapshot.epoch) return event;
  const diagnostics = mergeDiagnostics(snapshot.diagnostics, diagnosticsFromEvent(event));
  return hasDiagnostics(diagnostics) ? { ...event, relay_diagnostics: diagnostics } : event;
}

module.exports = { withSessionDiagnostics };
