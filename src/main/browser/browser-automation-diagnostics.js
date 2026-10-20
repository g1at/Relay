'use strict';

const { randomUUID } = require('node:crypto');

const LIMITATIONS = Object.freeze([
  'collection-starts-after-diagnostics-enabled',
  'older-runtime-events-not-replayed',
  'headers-bodies-cookies-not-collected',
  'console-objects-and-stacks-omitted',
  'console-secret-redaction-best-effort',
  'urls-omit-credentials-query-and-fragment',
  'bounded-history-shared-cursor',
  'request-correlation-limited-to-retained-ids',
]);
const SECRET_NAME = '(?:authorization|proxy-authorization|password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|session[_-]?id|session|cookie|set-cookie)';
const SECRET_LABEL = new RegExp('(?:^|\\b)' + SECRET_NAME + '\\s*[:=]?\\s*(?:%[sdifoO])?\\s*$', 'i');
const SECRET_ASSIGNMENT = new RegExp('(\\b' + SECRET_NAME + '\\b["\\\']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|\\\'[^\\\'\\r\\n]*\\\'|[^\\s,;&}]+)', 'gi');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const RESOURCE_TYPES = new Set(['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Ping', 'CSPViolationReport', 'Preflight', 'Other']);
const failure = (code, message) => Object.assign(new Error(message), { code });

function publicUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 16384) return '[URL omitted]';
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return `${url.protocol}[redacted]`;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.slice(0, 2048);
  } catch (_) { return '[invalid URL]'; }
}

function publicText(value, maximum = 500) {
  if (typeof value !== 'string') return '';
  // Limit work before applying patterns. An overlong argument is omitted in
  // full, because truncating first could retain only part of a secret label.
  if (value.length > 8192) return '[overlong string omitted]';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, publicUrl)
    .replace(/\b(?:data|blob|file|javascript):[^\s<>"']+/gi, '[URL omitted]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(SECRET_ASSIGNMENT, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[long token redacted]')
    .slice(0, maximum);
}

function primitive(argument, redact = false) {
  if (redact) return { type: 'redacted', value: '[redacted]' };
  if (!argument || typeof argument !== 'object') return { type: 'unknown', value: '[omitted]' };
  if (argument.type === 'object' && argument.subtype === 'null') return { type: 'null', value: null };
  if (argument.type === 'string') return { type: 'string', value: publicText(argument.value) };
  if (argument.type === 'boolean' && typeof argument.value === 'boolean') return { type: 'boolean', value: argument.value };
  if (argument.type === 'number') {
    if (finite(argument.value)) return { type: 'number', value: argument.value };
    if (['NaN', 'Infinity', '-Infinity', '-0'].includes(argument.unserializableValue)) return { type: 'number', value: argument.unserializableValue };
  }
  if (argument.type === 'undefined') return { type: 'undefined', value: 'undefined' };
  // Never read descriptions, previews, object IDs, accessors or stack objects.
  const type = ['object', 'function', 'symbol', 'bigint'].includes(argument.type) ? argument.type : 'unknown';
  return { type, value: '[omitted]' };
}

/** Collects protocol metadata only. It neither enables domains nor reads pages. */
function createBrowserDiagnostics({ now = Date.now, maxEvents = 400, maxRequests = 400 } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  for (const value of [maxEvents, maxRequests]) if (!Number.isInteger(value) || value < 1 || value > 1000) throw new RangeError('diagnostic capacities must be between 1 and 1000');
  const events = [], requests = new Map();
  let sequence = 0, disposed = false, runtimeStart = now(), collectionId = randomUUID();
  if (!finite(runtimeStart)) throw new TypeError('now must return an epoch timestamp');
  function append(kind, type, details) {
    const timestamp = now();
    events.push({ seq: ++sequence, at: finite(timestamp) ? timestamp : null, kind, type, ...details });
    if (events.length > maxEvents) events.shift();
  }
  function remember(id, entry) {
    requests.delete(id); requests.set(id, entry);
    if (requests.size > maxRequests) requests.delete(requests.keys().next().value);
    return entry;
  }
  function identity(params) {
    const id = params.requestId;
    return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id) ? id : null;
  }
  function networkIdentity(id, entry) {
    return { requestId: id, hop: entry?.hop ?? null, requestKnown: entry?.requestSeen === true,
      ...(entry?.url ? { url: entry.url } : {}) };
  }
  function responseDetails(response = {}) {
    const status = finite(response.status) && response.status >= 0 && response.status <= 999 ? response.status : null;
    return { status, httpError: status !== null && status >= 400,
      ...(response.url ? { url: publicUrl(response.url) } : {}),
      ...(typeof response.mimeType === 'string' ? { mimeType: publicText(response.mimeType, 100) } : {}),
      ...(typeof response.protocol === 'string' ? { protocol: publicText(response.protocol, 40) } : {}),
      fromDiskCache: response.fromDiskCache === true, fromServiceWorker: response.fromServiceWorker === true };
  }
  function handleMessage(method, params = {}) {
    if (disposed || !params || typeof params !== 'object' || Array.isArray(params)) return false;
    // Runtime.enable can replay cached console/exception messages. Runtime
    // Timestamp is epoch milliseconds; reject pre-lease messages on reattach.
    if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown'].includes(method)
        && (!finite(params.timestamp) || params.timestamp < runtimeStart)) return false;
    if (method === 'Runtime.consoleAPICalled') {
      const source = Array.isArray(params.args) ? params.args : [];
      const args = source.slice(0, 8).map((argument, index) => primitive(argument,
        index > 0 && source[index - 1]?.type === 'string' && typeof source[index - 1].value === 'string'
          && source[index - 1].value.length <= 8192 && SECRET_LABEL.test(source[index - 1].value)));
      const level = ['log', 'debug', 'info', 'error', 'warning', 'dir', 'dirxml', 'table', 'trace', 'clear', 'startGroup', 'startGroupCollapsed', 'endGroup', 'assert', 'profile', 'profileEnd', 'count', 'timeEnd'].includes(params.type) ? params.type : 'log';
      append('console', 'message', { level, args, omittedArguments: Math.max(0, source.length - args.length) });
      return true;
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails;
      if (!details || typeof details !== 'object') return false;
      // Error descriptions include full stacks. Keep only the first line, and
      // do not inspect arbitrary object descriptions for thrown page values.
      const error = details.exception;
      const message = error?.subtype === 'error' && typeof error.description === 'string'
        ? error.description.split(/\r?\n/, 1)[0] : details.text;
      append('console', 'exception', { level: 'error', message: publicText(message),
        ...(details.url ? { url: publicUrl(details.url) } : {}),
        ...(Number.isSafeInteger(details.lineNumber) && details.lineNumber >= 0 ? { line: details.lineNumber + 1 } : {}),
        ...(Number.isSafeInteger(details.columnNumber) && details.columnNumber >= 0 ? { column: details.columnNumber + 1 } : {}) });
      return true;
    }
    if (!['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method)) return false;
    const id = identity(params); if (!id) return false;
    let entry = requests.get(id);
    if (method === 'Network.requestWillBeSent') {
      if (!params.request || typeof params.request !== 'object' || typeof params.request.url !== 'string') return false;
      const previous = entry, redirected = !!params.redirectResponse;
      if (redirected) append('network', 'redirect', { ...networkIdentity(id, previous), ...responseDetails(params.redirectResponse), to: publicUrl(params.request.url) });
      entry = remember(id, { hop: previous ? previous.hop + 1 : redirected ? 1 : 0,
        requestSeen: true, url: publicUrl(params.request.url), completed: false });
      append('network', 'request', { ...networkIdentity(id, entry),
        method: typeof params.request.method === 'string' && params.request.method.length <= 20
          && /^[A-Za-z]+$/.test(params.request.method) ? params.request.method.toUpperCase() : '[unknown]',
        resourceType: RESOURCE_TYPES.has(params.type) ? params.type : 'Other', redirected, requestIdReused: !!previous && !redirected });
    } else if (method === 'Network.responseReceived') {
      if (!params.response || typeof params.response !== 'object') return false;
      if (!entry) entry = remember(id, { hop: 0, requestSeen: false, url: publicUrl(params.response.url), completed: false });
      const response = responseDetails(params.response); entry.status = response.status;
      append('network', 'response', { ...networkIdentity(id, entry), ...response });
    } else if (method === 'Network.loadingFinished') {
      append('network', 'finished', { ...networkIdentity(id, entry), transportFailure: false,
        ...(finite(params.encodedDataLength) && params.encodedDataLength >= 0 ? { encodedDataLength: params.encodedDataLength } : {}) });
      if (entry) entry.completed = true;
    } else {
      append('network', 'failed', { ...networkIdentity(id, entry), transportFailure: true,
        error: publicText(params.errorText, 250), canceled: params.canceled === true,
        ...(params.blockedReason ? { blockedReason: publicText(params.blockedReason, 80) } : {}),
        ...(params.corsErrorStatus?.corsError ? { corsError: publicText(params.corsErrorStatus.corsError, 80) } : {}) });
      if (entry) entry.completed = true;
    }
    return true;
  }
  function read({ kind = 'all', since = 0, limit = 100, collectionId: expectedCollection } = {}) {
    if (disposed) throw failure('BROWSER_DIAGNOSTICS_DISPOSED', '诊断记录已随浏览器控制连接释放。');
    if (!['all', 'console', 'network'].includes(kind)) throw failure('BROWSER_DIAGNOSTICS_INVALID_KIND', '诊断类型必须是 all、console 或 network。');
    if (!Number.isSafeInteger(since) || since < 0) throw failure('BROWSER_DIAGNOSTICS_INVALID_CURSOR', '诊断游标无效，请从 0 开始读取当前记录。');
    if ((since > 0 || expectedCollection !== undefined) && expectedCollection !== collectionId) {
      throw failure('BROWSER_DIAGNOSTICS_STALE_COLLECTION', '诊断记录已更新，请省略 collectionId 并从 since: 0 重新读取。');
    }
    if (since > sequence) throw failure('BROWSER_DIAGNOSTICS_INVALID_CURSOR', '诊断游标超出当前记录，请从 0 重新读取。');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw failure('BROWSER_DIAGNOSTICS_INVALID_LIMIT', '一次最多读取 200 条诊断记录。');
    const matching = events.filter(event => event.seq > since && (kind === 'all' || event.kind === kind));
    const page = matching.slice(0, limit), hasMore = matching.length > page.length;
    return { collectionId, events: JSON.parse(JSON.stringify(page)), cursor: hasMore ? page.at(-1).seq : sequence,
      dropped: Math.max(0, (events[0]?.seq ?? sequence + 1) - since - 1), hasMore, limitations: [...LIMITATIONS] };
  }
  function clear() {
    events.length = 0; requests.clear(); collectionId = randomUUID();
    const timestamp = now(); if (finite(timestamp)) runtimeStart = Math.max(runtimeStart, timestamp);
  }
  function dispose() { disposed = true; clear(); }
  return { handleMessage, read, clear, dispose };
}

module.exports = { createBrowserDiagnostics };
