'use strict';

const { createHash, randomUUID, X509Certificate } = require('node:crypto');
const { isIP } = require('node:net');
const OVERRIDABLE = new Set(['ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID']);
const sessionTrust = new WeakMap();
const clean = (value, max = 256) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const error = (code, message) => Object.assign(new Error(message), { code });

function localBrowserAddress(value) {
  try {
    const url = new URL('http://' + value), host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (isIP(host) === 6) return host === '::1' || /^(?:fc|fd|fe[89ab])/i.test(host);
    if (isIP(host) !== 4) return false;
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254;
  } catch (_) { return false; }
}
function webUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null; }
  catch (_) { return null; }
}
function certificateInfo(certificate) {
  let fingerprint;
  try { fingerprint = createHash('sha256').update(new X509Certificate(certificate?.data).raw).digest('hex'); }
  catch (_) {
    const supplied = String(certificate?.fingerprint || '').replace(/:/g, '').toLowerCase();
    if (/^[a-f0-9]{64}$/.test(supplied)) fingerprint = supplied;
  }
  return { fingerprint: fingerprint || null, subjectName: clean(certificate?.subjectName), issuerName: clean(certificate?.issuerName),
    validStart: Number.isFinite(certificate?.validStart) ? certificate.validStart : null,
    validExpiry: Number.isFinite(certificate?.validExpiry) ? certificate.validExpiry : null };
}

// Navigation challenges belong to one tab. Chromium also reuses accepted TLS
// connections across tabs in a Session, so trust metadata follows that Session
// across panel recreation and is never persisted to disk or globally installed.
function createBrowserConnectionSecurity({ partition, current, changed = () => {}, now = Date.now, idFactory = randomUUID } = {}) {
  let trust = sessionTrust.get(partition);
  if (!trust) { trust = { approvals: new Map(), listeners: new Set() }; sessionTrust.set(partition, trust); }
  const approvals = trust.approvals;
  let pending = null, closed = false, state = { state: 'none' };
  const publish = value => { state = value; changed(); };
  function cancel() {
    const previous = pending; pending = null;
    if (state.state === 'certificate-error') { state = { ...state, canContinue: false }; delete state.challengeId; }
    if (previous) { try { previous.callback(false); } catch (_) {} }
  }
  function target(value) {
    cancel();
    const url = webUrl(value), approved = url && approvals.get(url.origin);
    state = !url ? { state: 'none' } : url.protocol === 'http:' ? { state: 'http', origin: url.origin }
      : approved ? { state: 'certificate-exception', origin: url.origin, certificate: { ...approved.certificate }, temporary: true, scope: 'browser-session-origin' }
        : { state: 'secure', origin: url.origin };
  }
  function certificateError(event, value, failure, certificate, callback, isMainFrame) {
    event.preventDefault();
    const url = webUrl(value), info = certificateInfo(certificate), code = clean(failure).replace(/^net::/, '');
    const view = current(), approved = url && approvals.get(url.origin);
    if (closed || !view.alive || !url || url.protocol !== 'https:' || !info.fingerprint) { callback(false); return; }
    if (approved?.certificate.fingerprint === info.fingerprint && approved.errorCode === code) { callback(true); return; }
    // Subresource failures may never grant or replace main-document authority.
    if (isMainFrame === false || !webUrl(view.url) || webUrl(view.url).href !== url.href) { callback(false); return; }
    cancel();
    const canContinue = OVERRIDABLE.has(code);
    if (canContinue) pending = { callback, url: url.href, epoch: view.epoch, origin: url.origin,
      certificate: info, errorCode: code, challengeId: String(idFactory()), expires: now() + 5 * 60 * 1000 };
    publish({ state: 'certificate-error', origin: url.origin, certificate: info, errorCode: code,
      canContinue, ...(pending ? { challengeId: pending.challengeId } : {}) });
    if (!canContinue) callback(false);
  }
  function proceed(challengeId) {
    const view = current(), request = pending;
    if (closed || !request || challengeId !== request.challengeId || !view.alive || view.epoch !== request.epoch
      || webUrl(view.url)?.href !== request.url || now() > request.expires) {
      if (request && (now() > request.expires || !view.alive || view.epoch !== request.epoch)) cancel();
      throw error('CERTIFICATE_CHALLENGE_STALE', '证书确认已失效，请重新加载网页后确认');
    }
    pending = null;
    approvals.set(request.origin, { certificate: request.certificate, errorCode: request.errorCode });
    publish({ state: 'certificate-exception', origin: request.origin, certificate: { ...request.certificate }, temporary: true, scope: 'browser-session-origin' });
    request.callback(true);
    for (const listener of trust.listeners) listener();
  }
  const trustChanged = () => {
    if (closed) return;
    const view = current(), url = webUrl(view.url), approved = url && approvals.get(url.origin);
    if (!url || url.protocol !== 'https:' || !approved) return;
    if (pending && pending.origin === url.origin && pending.certificate.fingerprint === approved.certificate.fingerprint && pending.errorCode === approved.errorCode) {
      if (!view.alive || view.epoch !== pending.epoch || url.href !== pending.url || now() > pending.expires) { cancel(); changed(); return; }
      const request = pending; pending = null;
      state = { state: 'certificate-exception', origin: url.origin, certificate: { ...approved.certificate }, temporary: true, scope: 'browser-session-origin' };
      changed(); request.callback(true);
    } else if (state.state !== 'certificate-error') {
      state = { state: 'certificate-exception', origin: url.origin, certificate: { ...approved.certificate }, temporary: true, scope: 'browser-session-origin' };
      changed();
    }
  };
  trust.listeners.add(trustChanged);
  return { target, certificateError, proceed, cancel, snapshot: () => structuredClone(state),
    close() { closed = true; cancel(); trust.listeners.delete(trustChanged); state = { state: 'none' }; } };
}

module.exports = { localBrowserAddress, certificateInfo, createBrowserConnectionSecurity };
