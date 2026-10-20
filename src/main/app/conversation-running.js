'use strict';

// A warm SDK process or a saved goal does not mean work is running.
// Read these states synchronously with deletion's admission barrier.
function isConversationRunning(id, { liveSessions, liveTurnControls, miniChat, taskLedger } = {}) {
  const session = liveSessions?.get(id);
  if (session?.busy || session?.asyncAgentTracker?.size || session?.backgroundTaskTracker?.size
    || liveTurnControls?.isStopping(id)) return true;
  if (miniChat?.getConversationId() === id && miniChat.isRunning()) return true;
  return !!taskLedger?.list({ conversationId: id, terminal: false, limit: 1 }).length;
}

module.exports = { isConversationRunning };
