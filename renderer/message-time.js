// Compact local timestamps shared by the main and quick-chat answer footers.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayMessageTime = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const pad = value => String(value).padStart(2, '0');
  function dateFor(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function compact(value, now = new Date()) {
    const date = dateFor(value);
    if (!date) return '';
    const current = dateFor(now) || new Date();
    const year = date.getFullYear() === current.getFullYear() ? '' : date.getFullYear() + '年';
    return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  // Keep existing callers while using the same local date in hover text.
  // The <time datetime> attribute retains the unmodified precise timestamp.
  return { compact, full: compact };
});
