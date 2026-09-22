'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { SkillDraftService } = require('./skill-draft-service');
const { stageSkillProposals } = require('../sdk/sdk-native-events');
const service = new SkillDraftService(workerData);
const methods = new Set(['list', 'get', 'diff', 'validate', 'createDraft', 'publish', 'reject', 'rebaseDraft', 'rollback', 'listHistory']);

// The original synchronous validation and atomic replacement run on this thread.
// Message handlers cannot overlap; the host also dispatches only one at a time.
parentPort.on('message', request => {
  if (request?.type === 'close') { parentPort.close(); return; }
  const { requestId, method, args } = request || {};
  let drafts = null;
  try {
    if (!Number.isSafeInteger(requestId) || !Array.isArray(args)) throw new Error('Invalid skill draft request');
    let value;
    if (method === 'stageProposals') {
      drafts = [];
      value = stageSkillProposals(args[0], { service, skillsDir: workerData.skillsDir,
        stagingRoot: workerData.stagingRoot, sourceRef: args[1]?.sourceRef,
        onDraft: draft => drafts.push(draft) });
    } else {
      if (!methods.has(method)) throw new Error('Unknown skill draft operation');
      value = service[method](...args);
    }
    parentPort.postMessage({ requestId, ok: true, value });
  } catch (error) {
    parentPort.postMessage({ requestId, ok: false, error: { message: error.message, code: error.code || null,
      details: error.details || null, ...(drafts?.length ? { drafts } : {}) } });
  }
});
