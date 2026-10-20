(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelayBrowserActivity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clean = (value, max = 240) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
  function action(name) { return /^mcp__relay[-_]browser__([a-z_]+)$/.exec(String(name || ''))?.[1] || null; }
  function friendly(name, input = {}) {
    const verb = action(name); if (!verb) return null;
    const actions = { click: '点击网页元素', fill: '填写网页', press: '发送网页按键', scroll: '滚动网页', select: '选择网页选项', hover: '悬停网页元素', drag: '拖动网页元素', double_click: '双击网页元素', doubleClick: '双击网页元素', right_click: '打开网页菜单', rightClick: '打开网页菜单', scrollIntoView: '显示网页元素' };
    const labels = { focus: '显示任务网页', frames: '查看网页框架', locate: '定位网页元素', evidence: '查看任务浏览器证据', tabs: '查看任务网页', open: '打开任务网页', observe: '观察网页', verify: '核验网页结果', wait: '等待网页变化', diagnostics: '检查网页问题', upload: '上传任务文件', download: '下载网页文件', downloads: '查看任务下载', screenshot: '保存网页截图', navigate: '跳转网页', back: '网页后退', forward: '网页前进', reload: '刷新网页', close: '关闭任务网页', activate: '显示任务网页', mark: '保留任务网页', evaluate: '检查页面数据' };
    return { title: verb === 'act' ? actions[input.kind] || '操作网页' : labels[verb] || '操作任务网页',
      detail: clean(input.url || input.locator?.name || input.locator?.text || (verb === 'act' && input.kind === 'press' ? input.key : ''), 300) };
  }
  function payload(value) {
    let current = value;
    for (let n = 0; n < 5; n++) {
      if (typeof current === 'string') {
        if (current.length > 524288) return null;
        try { current = JSON.parse(current); continue; } catch (_) { return null; }
      }
      if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
      if (typeof current.ok === 'boolean' || typeof current.verified === 'boolean' || typeof current.satisfied === 'boolean') return current;
      if (Array.isArray(current.content)) { current = current.content.find(part => part?.type === 'text' && typeof part.text === 'string')?.text; continue; }
      const keys = Object.keys(current);
      if (keys.length === 1 && ['response', 'result', 'output', 'data'].includes(keys[0])) { current = current[keys[0]]; continue; }
      return null;
    }
    return null;
  }
  const localPath = value => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) && /^(?:[a-z]:[\\/]|\/(?!\/)|\\\\)/i.test(value);
  function summarize(name, value) {
    const verb = action(name), result = verb && payload(value); if (!result) return null;
    let tone = 'neutral', label = '', detail = '';
    if (result.outcome === 'unknown') { tone = 'warning'; label = '操作结果未确认'; detail = '可能已经生效，请重新观察并核验，勿直接重复操作。'; }
    else if (result.ok === false) { tone = 'error'; label = '网页操作未完成'; detail = clean(result.error || result.recovery, 400); }
    else if (verb === 'verify' && result.verified === false) { tone = 'error'; label = '页面结果未通过核验'; detail = '工具已返回，但页面尚未符合本次检查条件。'; }
    else if (verb === 'wait' && result.satisfied === false) { tone = 'error'; label = '等待结束，条件尚未满足'; detail = '请检查页面状态后再决定下一步。'; }
    else if (verb === 'verify' && result.verified === true) { tone = 'success'; label = '页面结果已核验'; }
    else if (verb === 'wait' && result.satisfied === true) { tone = 'success'; label = '页面已达到等待条件'; }
    else if (verb === 'act' && result.executed === true && result.waitResult?.satisfied === false) { tone = 'warning'; label = '动作已执行，等待条件未满足'; detail = '请检查页面或接口结果，勿直接重复提交。'; }
    else if (verb === 'act' && result.executed === true && result.waitResult?.satisfied === true) { label = '已执行，等待条件已满足'; }
    else if (verb === 'download' && result.download?.path) { label = '文件已保存'; }
    else if (verb === 'screenshot' && result.artifact?.path) { label = '网页截图已保存'; }
    else if (verb === 'act' || verb === 'upload') { label = result.executed === false ? '未执行' : '已执行'; }
    const evidenceWarning = result.evidenceWarning || result.artifact?.evidenceWarning || result.download?.evidenceWarning;
    if (evidenceWarning) detail = [detail, clean(evidenceWarning, 400)].filter(Boolean).join(' ');
    const resources = [];
    for (const [file, title] of [[result.artifact, '查看网页截图'], [result.download, '查看下载文件']]) {
      if (!localPath(file?.path)) continue;
      resources.push({ uri: file.path, kind: 'file', name: title });
    }
    return { action: verb, tone, label, detail, resources,
      imagePath: verb === 'screenshot' && localPath(result.artifact?.path) && /\.png$/i.test(result.artifact.path) ? result.artifact.path : null };
  }
  return { action, friendly, payload, summarize, localPath };
});
