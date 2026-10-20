'use strict';

const failure = (code, message) => Object.assign(new Error(message), { code });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rank = { commit: 0, domcontentloaded: 1, load: 2 };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

// Exact URLs are matched privately. Returned evidence excludes query strings,
// credentials and fragments, just like the browser diagnostics collector.
function publicUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol}[omitted]`;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.slice(0, 2048);
  } catch (_) { return '[URL omitted]'; }
}

function normalizeCondition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['navigation', 'response', 'load'].includes(input.event)) {
    throw failure('BROWSER_INVALID_EVENT_WAIT', '等待事件必须是 navigation、response 或 load。');
  }
  const event = input.event, timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw failure('BROWSER_INVALID_EVENT_WAIT', '事件等待时限须为 0 到 30000 毫秒。');
  if (input.url !== undefined && input.urlGlob !== undefined) throw failure('BROWSER_INVALID_EVENT_WAIT', 'url 和 urlGlob 不能同时指定。');
  for (const value of [input.url, input.urlGlob]) {
    if (value !== undefined && (typeof value !== 'string' || !value.length || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))) {
      throw failure('BROWSER_INVALID_EVENT_WAIT', '网址匹配条件无效或过长。');
    }
  }
  const waitUntil = input.waitUntil ?? (event === 'navigation' ? 'commit' : 'load');
  if (event !== 'response' && !Object.hasOwn(rank, waitUntil)) throw failure('BROWSER_INVALID_EVENT_WAIT', 'waitUntil 必须是 commit、domcontentloaded 或 load。');
  if (event === 'response' && input.waitUntil !== undefined) throw failure('BROWSER_INVALID_EVENT_WAIT', 'response 等待不接受 waitUntil。');
  if (event !== 'response' && (input.method !== undefined || input.status !== undefined)) throw failure('BROWSER_INVALID_EVENT_WAIT', 'method 和 status 仅用于 response 等待。');
  if (input.method !== undefined && (typeof input.method !== 'string' || !/^[A-Za-z]{1,20}$/.test(input.method))) throw failure('BROWSER_INVALID_EVENT_WAIT', 'HTTP method 无效。');
  if (input.status !== undefined && (!Number.isInteger(input.status) || input.status < 100 || input.status > 599)) throw failure('BROWSER_INVALID_EVENT_WAIT', 'HTTP status 须为 100 到 599。');
  if (input.frameId !== undefined && !identifier(input.frameId)) throw failure('BROWSER_INVALID_EVENT_WAIT', 'frameId 无效。');
  // A bounded matcher avoids regex backtracking on page-controlled URLs.
  const glob = input.urlGlob, exactUrl = input.url;
  const tokens = glob === undefined ? null : glob.match(/\*\*|\*|[^*]+/g);
  if (tokens && tokens.filter(token => token === '*' || token === '**').length > 32) throw failure('BROWSER_INVALID_EVENT_WAIT', '网址通配符过多。');
  function matchesUrl(url) {
    if (typeof url !== 'string' || url.length > 16384) return false;
    if (exactUrl !== undefined) return url === exactUrl;
    if (!tokens) return true;
    // Bounded dynamic programming; '*' never crosses '/', '**' may do so.
    let positions = new Uint8Array(url.length + 1); positions[0] = 1;
    for (const token of tokens) {
      const next = new Uint8Array(url.length + 1);
      if (token === '*' || token === '**') {
        for (let i = 0; i <= url.length; i++) next[i] = positions[i] || (i > 0 && next[i - 1] && (token === '**' || url[i - 1] !== '/')) ? 1 : 0;
      } else {
        for (let i = 0; i + token.length <= url.length; i++) if (positions[i] && url.startsWith(token, i)) next[i + token.length] = 1;
      }
      positions = next;
    }
    return positions[url.length] === 1;
  }
  return { event, timeoutMs, waitUntil, matchesUrl, method: input.method?.toUpperCase(), status: input.status, frameId: input.frameId };
}

/**
 * Root-session event metadata only: no commands, page evaluation, response bodies
 * or headers. The adapter enables Page/Network and Page lifecycle events before
 * prepare(), forwards debugger messages, and seeds frameTree + readyState.
 * prepare() registers synchronously so actions may immediately follow it.
 */
function createBrowserEventTracker({ webContents, now = Date.now, maxRequests = 500, maxWaiters = 16,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof now !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') throw new TypeError('Invalid event tracker clock');
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 2000 || !Number.isInteger(maxWaiters) || maxWaiters < 1 || maxWaiters > 64) throw new RangeError('Invalid event tracker capacity');
  const waiters = new Set(), requests = new Map(), documents = new Map();
  let frame = null, sequence = 0, navigation = null, disposed = false, awaitingCommit = false;
  const key = (frameId, loaderId) => JSON.stringify([frameId, loaderId]);
  function documentState(frameId, loaderId) {
    const id = key(frameId, loaderId);
    if (!documents.has(id)) {
      documents.set(id, { stage: 'commit', frameId, loaderId });
      if (documents.size > 32) documents.delete(documents.keys().next().value);
    }
    return documents.get(id);
  }
  function sameDocument(value) { return frame && value.frameId === frame.frameId && value.loaderId === frame.loaderId; }
  function details(value) { return { frameId: value.frameId, loaderId: value.loaderId, url: publicUrl(value.url), sequence: value.sequence }; }
  function failAll(error) { for (const waiter of [...waiters]) waiter.reject(error); }
  function reset(error = failure('BROWSER_CONNECTION_LOST', '浏览器控制连接已断开，事件等待已取消。')) {
    failAll(error); requests.clear(); documents.clear(); frame = null; navigation = null; awaitingCommit = false; sequence++;
  }
  function dispose(error = failure('BROWSER_TARGET_CLOSED', '浏览器标签页已关闭或控制连接已释放。')) {
    if (disposed) return; disposed = true; reset(error);
    webContents?.removeListener?.('destroyed', onDestroyed);
    webContents?.debugger?.removeListener?.('detach', onDetach);
  }
  function onDestroyed() { dispose(); }
  function onDetach() { reset(); }
  webContents?.on?.('destroyed', onDestroyed);
  webContents?.debugger?.on?.('detach', onDetach);

  function setMainFrame(value) {
    if (disposed || !identifier(value?.frameId) || !identifier(value?.loaderId)) return false;
    // A late getFrameTree/readiness query must never roll back a newer commit.
    if (frame && !sameDocument(value)) return false;
    // Same-document navigation retains loaderId; keep its newer event URL too.
    if (!frame) frame = { frameId: value.frameId, loaderId: value.loaderId, url: typeof value.url === 'string' ? value.url.slice(0, 16384) : '' };
    const state = documentState(frame.frameId, frame.loaderId);
    const stage = value.readyState === 'complete' ? 'load' : value.readyState === 'interactive' ? 'domcontentloaded' : 'commit';
    if (!awaitingCommit && rank[stage] > rank[state.stage]) state.stage = stage;
    for (const waiter of waiters) evaluate(waiter);
    return true;
  }

  function evaluate(waiter, response) {
    if (waiter.done || waiter.settling || !frame || now() >= waiter.end) return;
    const condition = waiter.condition;
    if (condition.frameId && frame.frameId !== condition.frameId) return;
    if (condition.event === 'response') {
      if (!response || response.sequence <= waiter.armed || !sameDocument(response) || !condition.matchesUrl(response.url)
          || (condition.method && response.method !== condition.method) || (condition.status !== undefined && response.status !== condition.status)) return;
      waiter.finish({ matched: true, satisfied: true, timedOut: false, event: 'response', ...details(response),
        requestId: response.requestId, method: response.method, status: response.status, resourceType: response.resourceType });
      return;
    }
    if (awaitingCommit) return;
    const target = condition.event === 'navigation' ? navigation : { ...frame, sequence };
    if (!target || !sameDocument(target) || (condition.event === 'navigation' && target.sequence <= waiter.armed) || !condition.matchesUrl(target.url)) return;
    const stage = documentState(frame.frameId, frame.loaderId).stage;
    if (rank[stage] < rank[condition.waitUntil]) return;
    waiter.finish({ matched: true, satisfied: true, timedOut: false, event: condition.event, ...details(target), waitUntil: condition.waitUntil,
      ...(condition.event === 'navigation' ? { sameDocument: target.sameDocument === true } : {}) });
  }

  function prepare(input, { signal, check, deadline } = {}) {
    if (disposed || webContents?.isDestroyed?.()) throw failure('BROWSER_TARGET_CLOSED', '浏览器标签页已关闭。');
    const condition = normalizeCondition(input);
    if (!frame) throw failure('BROWSER_EVENT_NOT_READY', '请先启用浏览器事件并读取主页面。');
    if (condition.frameId && condition.frameId !== frame.frameId) throw failure('BROWSER_EVENT_FRAME_UNSUPPORTED', '此事件等待仅支持当前主页面，不能等待子框架事件。');
    if (check !== undefined && typeof check !== 'function') throw new TypeError('check must be a function');
    if (deadline !== undefined && !finite(deadline)) throw failure('BROWSER_INVALID_EVENT_WAIT', '事件等待 deadline 无效。');
    if (waiters.size >= maxWaiters) throw failure('BROWSER_EVENT_WAIT_LIMIT', '同时等待的浏览器事件过多。');
    let resolve, reject, timer;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    // An action can throw before the caller awaits this already-armed promise.
    result.catch(() => {});
    const started = now();
    if (!finite(started)) throw new TypeError('now must return a finite timestamp');
    const waiter = { condition, armed: sequence, done: false, settling: false, end: Math.min(started + condition.timeoutMs, deadline ?? Infinity) };
    const cleanup = () => { clearTimer(timer); signal?.removeEventListener('abort', abort); waiters.delete(waiter); };
    waiter.reject = error => { if (waiter.done) return; waiter.done = true; cleanup(); reject(error); };
    const abort = () => waiter.reject(failure('BROWSER_CANCELLED', '浏览器事件等待已取消。'));
    waiter.finish = async value => {
      if (waiter.done || waiter.settling) return;
      waiter.settling = true;
      try {
        if (signal?.aborted) return abort();
        if (check && value.satisfied) await check();
        if (waiter.done) return;
        if (signal?.aborted) return abort();
        if (disposed || webContents?.isDestroyed?.()) return waiter.reject(failure('BROWSER_TARGET_CLOSED', '浏览器标签页已关闭。'));
        waiter.done = true; cleanup(); resolve(value);
      } catch (error) { waiter.reject(error); }
    };
    waiters.add(waiter); signal?.addEventListener('abort', abort, { once: true });
    const duration = Math.max(0, waiter.end - now());
    timer = setTimer(() => {
      // Do not allow a never-resolving async owner check to defeat the bound.
      if (waiter.settling) waiter.reject(failure('BROWSER_EVENT_CHECK_TIMEOUT', '浏览器权限检查未在事件等待时限内完成。'));
      else waiter.finish({ matched: false, satisfied: false, timedOut: true, event: condition.event, reason: 'timeout' });
    }, duration);
    if (signal?.aborted) abort();
    else if (duration > 0) evaluate(waiter);
    return { result, dispose: () => waiter.reject(failure('BROWSER_CANCELLED', '浏览器事件等待已取消。')) };
  }

  function handleMessage(method, params = {}, sessionId) {
    if (disposed || sessionId || !params || typeof params !== 'object' || Array.isArray(params)) return false;
    if (method === 'Page.frameNavigated') {
      const next = params.frame;
      if (!next || next.parentId || !identifier(next.id) || !identifier(next.loaderId)) return false;
      if (frame && frame.frameId === next.id && frame.loaderId === next.loaderId) return false;
      sequence++;
      awaitingCommit = false;
      frame = { frameId: next.id, loaderId: next.loaderId, url: typeof next.url === 'string' ? next.url.slice(0, 16384) : '' };
      navigation = { ...frame, sequence, sameDocument: false };
      documentState(frame.frameId, frame.loaderId);
      for (const waiter of waiters) {
        evaluate(waiter);
        for (const request of requests.values()) if (request.response && sameDocument(request)) evaluate(waiter, request.response);
      }
      for (const [id, request] of requests) if (!sameDocument(request)) requests.delete(id);
      return true;
    }
    if (method === 'Page.navigatedWithinDocument') {
      if (!frame || params.frameId !== frame.frameId || typeof params.url !== 'string') return false;
      sequence++; frame = { ...frame, url: params.url.slice(0, 16384) }; navigation = { ...frame, sequence, sameDocument: true };
      for (const waiter of waiters) evaluate(waiter);
      return true;
    }
    if (method === 'Page.frameStartedLoading' || method === 'Page.frameStoppedLoading') {
      if (!frame || params.frameId !== frame.frameId) return false;
      sequence++; awaitingCommit = method === 'Page.frameStartedLoading';
      if (!awaitingCommit) for (const waiter of waiters) evaluate(waiter);
      return true;
    }
    if (method === 'Page.lifecycleEvent') {
      if (!identifier(params.frameId) || !identifier(params.loaderId) || !['DOMContentLoaded', 'load', 'init'].includes(params.name)) return false;
      // Root-session child frames still emit Page events; never accept them.
      if (frame && params.frameId !== frame.frameId) return false;
      sequence++;
      const state = documentState(params.frameId, params.loaderId), stage = params.name === 'load' ? 'load' : params.name === 'DOMContentLoaded' ? 'domcontentloaded' : 'commit';
      if (params.name === 'init') state.stage = 'commit';
      else if (rank[stage] > rank[state.stage]) state.stage = stage;
      for (const waiter of waiters) evaluate(waiter);
      return true;
    }
    if (method === 'Network.requestWillBeSent') {
      if (!frame || !identifier(params.requestId) || params.frameId !== frame.frameId || !identifier(params.loaderId)
          || !params.request || typeof params.request.url !== 'string' || params.request.url.length > 16384 || !/^[A-Za-z]{1,20}$/.test(params.request.method || '')) return false;
      sequence++;
      // Document requests may precede their commit. They cannot satisfy a wait
      // until the matching main-frame loader becomes current.
      if (params.loaderId !== frame.loaderId && params.type !== 'Document') return false;
      requests.delete(params.requestId);
      requests.set(params.requestId, { requestId: params.requestId, frameId: params.frameId, loaderId: params.loaderId,
        method: params.request.method.toUpperCase(), url: params.request.url, resourceType: typeof params.type === 'string' ? params.type.slice(0, 40) : 'Other' });
      if (requests.size > maxRequests) requests.delete(requests.keys().next().value);
      return true;
    }
    if (method === 'Network.responseReceived') {
      const request = requests.get(params.requestId), response = params.response;
      if (!request || !response || params.frameId !== request.frameId || params.loaderId !== request.loaderId || typeof response.url !== 'string'
          || response.url.length > 16384 || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) return false;
      const value = { requestId: request.requestId, frameId: request.frameId, loaderId: request.loaderId, method: request.method,
        resourceType: request.resourceType, url: response.url, status: response.status, sequence: ++sequence };
      request.response = value;
      for (const waiter of waiters) evaluate(waiter, value);
      return true;
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const request = requests.get(params.requestId);
      // Keep an early document response only until its upcoming frame commit.
      if (request && (sameDocument(request) || !request.response || method === 'Network.loadingFailed')) requests.delete(params.requestId);
      return !!request;
    }
    return false;
  }

  return { prepare, handleMessage, setMainFrame, reset, dispose };
}

module.exports = { createBrowserEventTracker };
