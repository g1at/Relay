'use strict';
const { createConversationPermissions } = require('../../src/main/projects/conversation-permissions');

// Real metadata semantics for VM tests that extract only a narrow main block.
// All settings/history remain in the caller's synthetic fixture.
module.exports = function installPermissions(context) {
  require('./sdk-provenance-fixture')(context);
  context.protectGoalRecovery = require('../../src/main/projects/conversation-goals').protectGoalRecovery;
  context.goalConditionValue = require('../../src/main/projects/conversation-goals').condition;
  let settings = { permissionMode: 'default', ...(context.readAppSettings ? context.readAppSettings() : {}) };
  const service = createConversationPermissions({
    readSettings: () => settings, writeSettings: value => { settings = value; },
    loadConversation: id => context.loadConversation ? context.loadConversation(id) : null,
    persistConversation: record => {
      if (context.persistConversationRecord) context.persistConversationRecord(record);
      else if (context.saveConversation) context.saveConversation(record);
    },
  });
  context.getConversationPermissions = () => service;
  context.conversationPermissionSnapshot = id => service.get(id && context.loadConversation && context.loadConversation(id) ? id : null);
  return service;
};
