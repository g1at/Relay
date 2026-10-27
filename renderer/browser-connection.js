(function () {
  'use strict';
  function describe(tab = {}) {
    let protocol = '', host = '';
    try { const url = new URL(tab.url); protocol = url.protocol; host = url.host; } catch (_) {}
    const connection = tab.connection || {};
    let state = tab.isPreview ? 'preview' : connection.state || (/ERR_CERT_/i.test(tab.error || '') ? 'certificate-error'
      : protocol === 'http:' ? 'http' : 'none');
    if (state === 'secure' && (tab.loading || tab.error)) state = 'none';
    const certificateError = state === 'certificate-error', exception = state === 'certificate-exception';
    const code = connection.errorCode || (String(tab.error || '').match(/ERR_[A-Z_]+/) || [])[0] || '';
    const titles = { http: 'HTTP 连接 · 未加密', secure: 'HTTPS 加密连接', 'certificate-error': '网站证书未通过验证',
      'certificate-exception': '已允许此网站证书', preview: '本地代码预览', none: tab.loading ? '正在连接网站' : '网站连接尚未确认' };
    const descriptions = { http: '此网站使用 HTTP，连接未加密。', secure: '此网站使用 HTTPS，连接已加密。',
      'certificate-error': '浏览器无法确认这个网站的身份。网站可能使用了内部证书，也可能存在证书配置问题。',
      'certificate-exception': '本次浏览会话中，此网站的当前证书已获临时信任，并适用于同一站点的其他标签页。退出 Relay 后失效。证书仍未通过常规验证。',
      preview: '正在预览本地生成的页面。', none: tab.loading ? '连接建立后，可在这里查看网站信息。' : '当前页面尚未建立可确认的连接。' };
    return { state, host, code, icon: certificateError || exception ? 'warning' : state === 'secure' ? 'lock' : tab.isPreview ? 'code' : 'site',
      title: titles[state] || titles.none, description: descriptions[state] || descriptions.none,
      failed: !tab.loading && (!!tab.error || certificateError),
      errorTitle: certificateError ? '这个网站的证书无法验证' : '暂时无法打开这个网页',
      errorDescription: certificateError ? descriptions['certificate-error'] : '请检查网址或网络连接，然后重新加载。',
      canContinue: certificateError && connection.canContinue === true && !!connection.challengeId,
      canUseHttp: protocol === 'https:' && (!!tab.error || certificateError), certificate: connection.certificate || null };
  }
  window.RelayBrowserConnection = { describe };
}());
