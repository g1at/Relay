'use strict';
// Narrow main-process VM tests use the real native metadata implementation.
module.exports = function installProvenance(context) {
  Object.assign(context, require('../../sdk-session-provenance'));
  context.process ||= { env: {} };
  context.path ||= require('node:path');
  context.os ||= { homedir: () => '/synthetic-home' };
  return context;
};
