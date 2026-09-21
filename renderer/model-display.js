(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayModelDisplay = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function modelName(modelId) {
    const parts = String(modelId || '').trim().split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1].trim() : '';
  }

  // Display the configured route, never a capability alias left over from a
  // previous SDK session. The full identifier is retained only for routing.
  function describeRoute(route, { loaded = true } = {}) {
    const modelId = String(route && route.modelId || '').trim();
    const name = modelName(modelId);
    const label = name || (loaded ? '未配置模型' : '正在加载模型');
    return { modelId, label, tooltip: label, configured: !!name };
  }

  function effortVisualState(levels, selectedIndex) {
    if (!Array.isArray(levels) || !levels.length) return { index: 0, level: null, fraction: 0 };
    const index = Math.max(0, Math.min(levels.length - 1, Math.round(Number(selectedIndex) || 0)));
    return { index, level: levels[index], fraction: levels.length === 1 ? 1 : index / (levels.length - 1) };
  }

  return { modelName, describeRoute, effortVisualState };
});
