'use strict';
const { createTurnDeliveryService, protectTurnDeliverables } = require('../../src/main/app/turn-delivery-service');
const { createTurnDeliveryHooks } = require('../../src/main/app/turn-delivery-hooks');

// Extracted main-process blocks use the real delivery rules and hooks. Reads
// and writes stay in the caller's isolated conversation fixture; durable
// progress storage is exercised separately by the delivery persistence tests.
module.exports = function installTurnDelivery(context) {
  context.protectTurnDeliverables = protectTurnDeliverables;
  context.createTurnDeliveryHooks = createTurnDeliveryHooks;
  context.turnDeliveryService = null;
  context.getTurnDeliveryService = () => context.turnDeliveryService ||= createTurnDeliveryService({
    load: id => context.loadConversation ? context.loadConversation(id) : null,
    persist: record => context.persistConversationRecord(record),
    canWrite: id => context.getConversationDeletion ? context.getConversationDeletion().canWrite(id) : true,
  });
};
