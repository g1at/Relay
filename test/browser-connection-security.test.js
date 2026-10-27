'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { localBrowserAddress, certificateInfo, createBrowserConnectionSecurity } = require('../src/main/browser/browser-connection-security');
const { normalizeBrowserUrl, resolveBrowserAddress } = require('../src/main/browser/browser-panel-host');
const certificate = { data: fs.readFileSync(path.join(__dirname, 'fixtures/browser-tls/localhost.pem'), 'utf8'), subjectName: 'localhost', issuerName: 'Relay fixture' };
function fixture(partition = {}, url = 'https://localhost:8443/') {
  const view = { url, epoch: 1, alive: true }, callbacks = [], changes = [];
  let clock = 1000, sequence = 0;
  const security = createBrowserConnectionSecurity({ partition, current: () => view, now: () => clock,
    idFactory: () => 'challenge-' + ++sequence, changed: () => changes.push(security.snapshot()) });
  security.target(url);
  return { security, view, callbacks, changes, partition, advance: ms => { clock += ms; },
    fail(cert = certificate, failure = 'net::ERR_CERT_AUTHORITY_INVALID', target = view.url, main = true) {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      security.certificateError(event, target, failure, cert, accepted => callbacks.push(accepted), main);
      assert.equal(event.prevented, true); return security.snapshot();
    } };
}
test('private addresses default to HTTP while explicit schemes and public host ports remain precise', () => {
  for (const address of ['10.250.1.248', '172.16.1.2:8080/a', '192.168.1.20', '169.254.1.2', 'localhost:4000', 'printer.local:8080/a', '[::1]:8080/a', '[fd00::1]:8080/a', '[fe80::1]:8080/a']) {
    assert.equal(localBrowserAddress(address), true, address);
    assert.equal(normalizeBrowserUrl(address), 'http://' + address + (address.includes('/a') ? '' : '/'));
    assert.equal(resolveBrowserAddress(address), normalizeBrowserUrl(address));
  }
  for (const address of ['10.example.com', '127.evil.test', '172.160.1.2', '192.168.example.com', '8.8.8.8']) {
    assert.equal(localBrowserAddress(address), false, address); assert.equal(resolveBrowserAddress(address), 'https://' + address + '/');
  }
  assert.equal(resolveBrowserAddress('example.test:8080/path'), 'https://example.test:8080/path');
  assert.equal(normalizeBrowserUrl('http://example.test:8080/path'), 'http://example.test:8080/path');
  assert.equal(resolveBrowserAddress('https://10.250.1.248'), 'https://10.250.1.248/');
  for (const address of ['file:///tmp/data', 'javascript:alert(1)', 'data:text/plain,hello']) assert.throws(() => resolveBrowserAddress(address));
});
test('certificate identity uses actual DER rather than a supplied display fingerprint', () => {
  const info = certificateInfo({ ...certificate, fingerprint: 'a'.repeat(64) });
  assert.equal(info.fingerprint, new X509Certificate(certificate.data).fingerprint256.replace(/:/g, '').toLowerCase());
  assert.equal(info.subjectName, 'localhost'); assert.equal(Object.hasOwn(info, 'data'), false);
});
test('a blocked certificate requires the current challenge before any native approval', () => {
  const f = fixture(), blocked = f.fail();
  assert.equal(blocked.state, 'certificate-error'); assert.equal(blocked.canContinue, true); assert.deepEqual(f.callbacks, []);
  assert.throws(() => f.security.proceed('forged'), { code: 'CERTIFICATE_CHALLENGE_STALE' }); assert.deepEqual(f.callbacks, []);
  f.security.proceed(blocked.challengeId); assert.deepEqual(f.callbacks, [true]); assert.equal(f.security.snapshot().scope, 'browser-session-origin');
  assert.throws(() => f.security.proceed(blocked.challengeId));
  f.fail(certificate, undefined, 'https://localhost:8443/another', false); assert.deepEqual(f.callbacks, [true, true]); f.security.close();
});
test('Session metadata survives tab or panel recreation, while another Session has no trust', () => {
  const a = fixture(), b = fixture(a.partition), blocked = a.fail(); b.fail(); a.security.proceed(blocked.challengeId);
  assert.deepEqual(a.callbacks, [true]); assert.deepEqual(b.callbacks, [true]); assert.equal(b.security.snapshot().state, 'certificate-exception');
  a.security.close(); b.security.close();
  const reopened = fixture(a.partition), fresh = fixture();
  assert.equal(reopened.security.snapshot().state, 'certificate-exception'); assert.equal(fresh.security.snapshot().state, 'secure');
  assert.equal(fresh.fail().state, 'certificate-error'); reopened.security.close(); fresh.security.close();
});
test('approval is bound to exact origin and certificate, including port and error category', () => {
  const f = fixture(), blocked = f.fail(); f.security.proceed(blocked.challengeId);
  for (const url of ['https://localhost:9443/', 'https://127.0.0.1:8443/']) {
    f.view.url = url; f.view.epoch++; f.security.target(url);
    const before = f.callbacks.length;
    assert.equal(f.fail().state, 'certificate-error', url); assert.equal(f.callbacks.length, before, 'new challenge still awaits approval');
  }
  f.security.target('https://localhost:8443/'); f.view.url = 'https://localhost:8443/';
  assert.equal(f.fail({ fingerprint: 'b'.repeat(64), subjectName: 'changed certificate' }).state, 'certificate-error');
  assert.equal(f.security.snapshot().certificate.fingerprint, 'b'.repeat(64)); f.security.close();
});
test('navigation, expiry, stop and close reject native requests without retaining approval', () => {
  for (const change of [f => { f.view.epoch++; }, f => { f.advance(300001); }, f => { f.view.alive = false; }]) {
    const f = fixture(), blocked = f.fail(); change(f);
    assert.throws(() => f.security.proceed(blocked.challengeId), { code: 'CERTIFICATE_CHALLENGE_STALE' });
    assert.deepEqual(f.callbacks, [false]); assert.equal(f.security.snapshot().canContinue, false); f.security.close();
  }
  const f = fixture(); f.fail(); f.security.cancel(); assert.deepEqual(f.callbacks, [false]);
  assert.equal(f.security.snapshot().challengeId, undefined); assert.equal(f.security.snapshot().canContinue, false); f.security.close();
  const later = fixture(f.partition); assert.equal(later.security.snapshot().state, 'secure'); later.security.close();
});
test('non-overridable and subframe-only failures never create an approval challenge', () => {
  const f = fixture(), rejected = f.fail(certificate, 'net::ERR_CERT_REVOKED');
  assert.equal(rejected.canContinue, false); assert.equal(rejected.challengeId, undefined); assert.deepEqual(f.callbacks, [false]);
  const fresh = fixture(); fresh.fail(certificate, undefined, 'https://widget.test/', false);
  assert.deepEqual(fresh.callbacks, [false]); assert.equal(fresh.security.snapshot().state, 'secure'); f.security.close(); fresh.security.close();
});
test('sibling approval cannot resume an obsolete pending navigation', () => {
  const a = fixture(), b = fixture(a.partition), blocked = a.fail(); b.fail(); b.view.epoch++;
  a.security.proceed(blocked.challengeId); assert.deepEqual(b.callbacks, [false]); assert.equal(b.security.snapshot().canContinue, false);
  a.security.close(); b.security.close();
});
