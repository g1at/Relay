'use strict';

const crypto = require('node:crypto');
const SCHEME = 'relay-preview';
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function previewDocument(html, title) {
  if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw Object.assign(new Error('预览内容为空或超过 2 MB，请保存为文件后打开'), { code: 'INVALID_PREVIEW' });
  }
  const url = `${SCHEME}://${crypto.randomUUID()}/index.html`;
  return { html, url, title: String(title || '代码预览').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180) || '代码预览' };
}

function ownsPreviewUrl(document, value) {
  if (!document || typeof value !== 'string') return false;
  try { const url = new URL(value); url.hash = ''; return url.href === document.url; } catch (_) { return false; }
}

// The scheme is registered on one non-persistent session, never globally. It
// has no file handler, privileged origin or access to the Relay preload.
function installPreviewSession(partition, document = null, inspectedContents = () => null) {
  let disposed = false;
  if (document) partition.protocol.handle(SCHEME, request => {
    if (disposed || !ownsPreviewUrl(document, request.url) || !['GET', 'HEAD'].includes(request.method)) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(request.method === 'HEAD' ? null : document.html, { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self' http: https: data: blob:; script-src 'self' http: https: blob: 'unsafe-inline' 'unsafe-eval'; style-src 'self' http: https: 'unsafe-inline'; connect-src http: https: ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    } });
  });
  partition.webRequest.onBeforeRequest((details, callback) => {
    // DevTools is created only by Relay's trusted toolbar, in a different
    // WebContents. Do not mistake its inspector document for preview content.
    const requester = details.webContents;
    const inspector = requester && requester !== inspectedContents() && requester.session === partition
      && requester.getType?.() === 'remote';
    if (!disposed && inspector) { callback({ cancel: false }); return; }
    const url = String(details.url || '');
    const web = /^https?:\/\//i.test(url) || /^wss?:\/\//i.test(url);
    const subresource = !['mainFrame', 'subFrame'].includes(details.resourceType);
    const allowed = web || ownsPreviewUrl(document, url) || url === 'about:blank'
      || subresource && /^(data:|blob:)/i.test(url);
    callback({ cancel: disposed || !allowed });
  });
  return { dispose() {
    if (disposed) return;
    disposed = true;
    if (document) { try { partition.protocol.unhandle(SCHEME); } catch (_) {} document.html = ''; }
    // Keep requests denied until the corresponding WebContents is destroyed.
  } };
}

module.exports = { previewDocument, ownsPreviewUrl, installPreviewSession, MAX_HTML_BYTES };
