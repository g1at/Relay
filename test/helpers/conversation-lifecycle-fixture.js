'use strict';

// Narrow VM fixtures have no deletion or migration in flight unless their test
// supplies an explicit guard. Production guard behavior has its own disk tests.
module.exports = function installConversationLifecycle(context) {
  context.assertConversationAvailable ||= () => {};
  context.getConversationDeletion ||= () => ({ canWrite: () => true });
  context.conversationRuntimes ||= require('../../src/main/app/conversation-runtime-lifecycle').createConversationRuntimeLifecycle();
};
