'use strict';

const UNATTRIBUTED_TURN = Symbol('unattributed-sdk-turn');

// A Relay run can span several SDK turns (Agent continuations and internal repair
// prompts). SDK reply correlation is stamped when the reply owner changes, so
// keep that binding between stamps instead of requiring a UUID on every frame.
function isErrorResult(event) {
  return event.is_error === true
    || (event.subtype && event.subtype !== 'success')
    || (Array.isArray(event.permission_denials) && event.permission_denials.length > 0);
}

function notificationIds(event) {
  if (event.type === 'system' && event.subtype === 'task_notification') {
    return { taskId: event.task_id, toolId: event.tool_use_id };
  }
  const content = event.type === 'user' && event.message && event.message.content;
  if (typeof content !== 'string' || !/<task-notification>/i.test(content)) return null;
  return {
    taskId: ((content.match(/<task-id>([^<]*)<\/task-id>/i) || [])[1] || '').trim(),
    toolId: ((content.match(/<tool-use-id>([^<]*)<\/tool-use-id>/i) || [])[1] || '').trim(),
  };
}

function isNotificationOnlyResult(event) {
  // Resuming an orphaned shell appends a shouldQuery:false notification, then
  // emits a zero-turn success even though no user request has been answered.
  // An actual Agent continuation also has this origin, but performs model turns.
  return event.type === 'result' && event.subtype === 'success' && !isErrorResult(event)
    && event.origin && event.origin.kind === 'task-notification'
    && event.num_turns === 0 && event.duration_api_ms === 0
    && !String(event.result || '').trim() && event.structured_output == null;
}

class LiveTurnRouter {
  constructor() {
    this.seenReplyUuid = false;
    this.replyOwner = null;
    this.foreignTaskIds = new Set();
    this.end();
  }

  begin(userMessageId) {
    this.end();
    this.active = true;
    this.sentIds = new Set(userMessageId ? [userMessageId] : []);
  }

  addSend(userMessageId) {
    if (userMessageId) this.sentIds.add(userMessageId);
    // A repair prompt starts another SDK turn belonging to the same Relay run.
    this.replyOwner = null;
  }

  registerSupplement(userMessageId) {
    if (!this.active || typeof userMessageId !== 'string' || !userMessageId || this.sentIds.has(userMessageId)) return false;
    this.sentIds.add(userMessageId);
    this.supplementIds.add(userMessageId);
    this.pendingSupplements.add(userMessageId);
    this.awaitingSupplementResults.add(userMessageId);
    // Adding input does not start a new SDK reply. The current turn keeps its
    // owner while the SDK may absorb this supplement at a later tool boundary.
    return true;
  }

  unregisterSupplement(userMessageId) {
    // Roll back a failed local push only; never forget a message already consumed.
    if (!this.pendingSupplements.delete(userMessageId)) return false;
    this.supplementIds.delete(userMessageId);
    this.awaitingSupplementResults.delete(userMessageId);
    this.sentIds.delete(userMessageId);
    return true;
  }

  get pendingSupplementCount() { return this.pendingSupplements.size; }

  hasPendingSupplements() { return this.pendingSupplementCount > 0; }

  pendingSupplementIds() { return [...this.pendingSupplements]; }

  resultPendingSupplementCount(event) {
    // `started` acknowledges absorption, not completion. A subsequent queued
    // turn can have started before an older result reaches the host. Current
    // SDK results explicitly enumerate the inputs they answered; never let the
    // older result close a run while such an input still awaits its own result.
    // Older producers have no consumed-input list, so retain their existing
    // lifecycle/first-reply fallback rather than waiting for an absent field.
    if (!Array.isArray(event?.user_message_uuids)) return this.pendingSupplementCount;
    return new Set([...this.pendingSupplements, ...this.awaitingSupplementResults]).size;
  }

  consumeSupplement(userMessageId) {
    this.pendingSupplements.delete(userMessageId);
    if (this.supplementFailures.delete(userMessageId)) this.awaitingSupplementResults.add(userMessageId);
  }

  end() {
    this.active = false;
    this.sentIds = new Set();
    this.supplementIds = new Set();
    this.pendingSupplements = new Set();
    this.awaitingSupplementResults = new Set();
    this.supplementFailures = new Map();
    this.toolIds = new Set();
    this.agentToolIds = new Set();
    this.taskIds = new Set();
    this.agentTaskIds = new Set();
    this.hasReply = false;
    this.userAccepted = false;
    this.awaitingAgent = false;
    this.foreignFrameActive = false;
    this.foreignNotificationPending = false;
    this.interruptRequested = false;
  }

  interrupt() { this.interruptRequested = true; }

  resetConversation() {
    // Keep the current run's submitted/queued input IDs: plan exit can reset
    // context while continuing that same send. Reply and task ownership must
    // be learned anew from the replacement session.
    this.replyOwner = null;
    this.seenReplyUuid = false;
    this.foreignTaskIds.clear();
    for (const key of ['toolIds', 'agentToolIds', 'taskIds', 'agentTaskIds']) this[key].clear();
    this.hasReply = false;
    this.userAccepted = false;
    this.awaitingAgent = false;
    this.foreignFrameActive = false;
    this.foreignNotificationPending = false;
  }

  noteResult(disposition, pendingAgents = 0) {
    this.awaitingAgent = disposition === 'wait' && pendingAgents > 0;
    // UUID-less Agent continuation frames belong to the run that launched them.
    if (this.awaitingAgent) this.replyOwner = null;
  }

  ownsNotification(ids) {
    return !!ids && (this.taskIds.has(ids.taskId) || this.toolIds.has(ids.toolId));
  }

  rememberTask(task) {
    if (!task || !task.task_id) return;
    this.taskIds.add(task.task_id);
    if (task.subagent_type || /agent|workflow/i.test(String(task.task_type || ''))
        || this.agentToolIds.has(task.tool_use_id)) this.agentTaskIds.add(task.task_id);
  }

  rememberTools(event) {
    let blocks = event.type === 'assistant' && event.message && event.message.content;
    if (event.type === 'stream_event' && event.event && event.event.type === 'content_block_start') {
      blocks = [event.event.content_block];
    }
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (!block || block.type !== 'tool_use' || !block.id) continue;
      this.toolIds.add(block.id);
      if (/^(Agent|Task)$/i.test(String(block.name || ''))) this.agentToolIds.add(block.id);
    }
  }

  accept(event) {
    if (!event || typeof event !== 'object') return null;
    const ids = notificationIds(event);
    if (!this.active) {
      if (ids && ids.taskId) this.foreignTaskIds.add(ids.taskId);
      if (ids || ((event.type === 'assistant' || event.type === 'stream_event')
          && !event.parent_tool_use_id && !event.subagent_type)) this.replyOwner = UNATTRIBUTED_TURN;
      if (event.user_message_uuid) {
        this.seenReplyUuid = true;
        this.replyOwner = event.user_message_uuid;
      }
      return null;
    }

    const reply = event.type === 'assistant' || event.type === 'stream_event';
    const child = !!(event.parent_tool_use_id || event.parentToolUseId || event.agent_id || event.subagent_type);
    const consumedIds = !child && Array.isArray(event.user_message_uuids)
      ? event.user_message_uuids.filter(id => typeof id === 'string' && this.sentIds.has(id)) : [];
    // New SDKs report every merged input, while the singular stamp names the
    // last member (which may have come from another client). An owned member
    // is sufficient to correlate the shared reply; never trust child frames.
    const singular = !child && event.user_message_uuid;
    const stamp = singular && this.sentIds.has(singular) ? singular : consumedIds.at(-1) || singular;
    if (stamp) {
      this.seenReplyUuid = true;
      if (!this.sentIds.has(stamp)) {
        if (reply) {
          this.replyOwner = stamp;
          this.foreignFrameActive = true;
        }
        return null;
      }
      this.replyOwner = stamp;
      this.userAccepted = true;
      this.foreignFrameActive = false;
      this.foreignNotificationPending = false;
    }

    if (isNotificationOnlyResult(event)) return null;
    if (event.type === 'command_lifecycle') {
      if (child || !this.sentIds.has(event.command_uuid)) return null;
      // CLI emits `started` for every absorbed/coalesced UUID. A queued event
      // or replayed user echo can precede suspension checks and is not consumption.
      if (event.state === 'started') this.consumeSupplement(event.command_uuid);
      if (/^(?:cancelled|discarded|refused)$/.test(String(event.state || '')) && this.pendingSupplements.delete(event.command_uuid)) {
        this.supplementFailures.set(event.command_uuid, event.state);
        this.awaitingSupplementResults.delete(event.command_uuid);
      }
      return event;
    }
    const resultCanProveConsumption = event.type === 'result' && event.num_turns !== 0;
    const successfulResult = resultCanProveConsumption && !isErrorResult(event)
      && !/^aborted_(streaming|tools)$/.test(String(event.terminal_reason || ''));
    if (stamp && (reply || (successfulResult && !Array.isArray(event.user_message_uuids)))) {
      this.consumeSupplement(stamp);
      for (const id of consumedIds) this.consumeSupplement(id);
    }
    if (!child && resultCanProveConsumption) {
      if (Array.isArray(event.user_message_uuids)) {
        // Error/abort results also enumerate prompts this turn consumed. This
        // acknowledges delivery, not successful completion of their requests.
        // A singular error stamp can instead name a failed delivery, so only
        // the explicit consumed list is authoritative for unsuccessful turns.
        for (const id of consumedIds) {
          this.consumeSupplement(id);
          this.awaitingSupplementResults.delete(id);
        }
      } else if (successfulResult) {
        for (const id of this.awaitingSupplementResults) {
          if (!this.pendingSupplements.has(id)) this.awaitingSupplementResults.delete(id);
        }
      }
    }
    if (ids) {
      if (!this.ownsNotification(ids)) {
        if (ids.taskId) this.foreignTaskIds.add(ids.taskId);
        if (!this.hasReply) {
          this.foreignNotificationPending = true;
          this.replyOwner = UNATTRIBUTED_TURN;
        }
        return null;
      }
      return event;
    }

    const foreignReply = this.replyOwner && !this.sentIds.has(this.replyOwner);
    if (event.type === 'result') {
      if (this.interruptRequested && /^aborted_(streaming|tools)$/.test(String(event.terminal_reason || ''))) return event;
      if (!stamp && !this.interruptRequested && event.origin && event.origin.kind === 'task-notification'
          && !this.awaitingAgent && !this.agentTaskIds.size && !this.agentToolIds.size) return null;
      // Fatal startup/session failures and interrupt results can have no UUID.
      // An explicitly foreign UUID was rejected above; never leave these real
      // failures running merely because no assistant frame preceded them.
      if (isErrorResult(event)) {
        if (!this.interruptRequested && (this.foreignFrameActive
            || ((foreignReply || this.foreignNotificationPending)
              && event.origin && event.origin.kind === 'task-notification'))) return null;
        return event;
      }
      if (foreignReply && !stamp) return null;
      // Older SDKs have neither first-frame nor result correlation. A concrete
      // reply/result remains the fallback; a bare empty success is not proof.
      if (!stamp && !this.hasReply && !this.userAccepted
          && !String(event.result || '').trim() && !(Number(event.num_turns) > 0)) return null;
      return event;
    }

    if (event.type === 'user' && event.uuid && this.sentIds.has(event.uuid)) {
      this.userAccepted = true;
      // Older emitters may acknowledge the submitted user message but omit
      // reply stamps. Its replay acknowledgement is also a valid turn boundary.
      if (!this.seenReplyUuid) {
        this.replyOwner = event.uuid;
        this.foreignNotificationPending = false;
      }
      return event;
    }
    if (reply) {
      if (child) {
        if (event.parent_tool_use_id && !this.toolIds.has(event.parent_tool_use_id)) return null;
        if (!event.parent_tool_use_id && !this.agentToolIds.size && !this.agentTaskIds.size) return null;
      } else {
        if (this.foreignNotificationPending && !stamp) return null;
        if (foreignReply && !stamp) return null;
        if (!stamp && !this.replyOwner && this.seenReplyUuid && !this.awaitingAgent) return null;
        this.hasReply = true;
        this.rememberTools(event);
      }
      return event;
    }

    if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
      const tasks = (Array.isArray(event.tasks) ? event.tasks : []).filter((task) => (
        task && (this.taskIds.has(task.task_id) || this.toolIds.has(task.tool_use_id)
          || (this.hasReply && !foreignReply && !this.foreignTaskIds.has(task.task_id)))
      ));
      for (const task of tasks) this.rememberTask(task);
      return { ...event, tasks };
    }
    if (event.type === 'system' && /^task_(started|updated|progress)$/.test(event.subtype || '')) {
      if (!this.taskIds.has(event.task_id) && !this.toolIds.has(event.tool_use_id)
          && (!this.hasReply || foreignReply || this.foreignTaskIds.has(event.task_id))) return null;
      this.rememberTask(event);
    }
    if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      const results = event.message.content.filter((block) => block && block.type === 'tool_result');
      if (results.length && !results.some((block) => this.toolIds.has(block.tool_use_id))) return null;
      const structured = event.tool_use_result || event.toolUseResult || {};
      const taskId = structured.agentId || structured.taskId || structured.task_id
        || structured.backgroundTaskId || structured.background_task_id;
      if (taskId && results.length) this.rememberTask({
        task_id: taskId, tool_use_id: results[0].tool_use_id,
      });
    }
    return event;
  }
}

module.exports = { LiveTurnRouter, isNotificationOnlyResult };
