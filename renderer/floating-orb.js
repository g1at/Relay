(function initFloatingOrb() {
  'use strict';
  const api = window.api && window.api.mini;
  if (!api) return;
  const orb = document.getElementById('relayOrb');
  const logo = document.getElementById('orbLogo');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  let theme = 'light', pointer = null, suppressClick = false, revision = 0;
  let lightFrame = 0, lightPoint = null;
  const off = [];
  const invoke = (name, argument) => {
    if (typeof api[name] !== 'function') return;
    try { Promise.resolve(api[name](argument)).catch(() => {}); } catch (_) {}
  };
  function applyTheme() {
    document.documentElement.dataset.theme = theme === 'dark' || theme === 'system' && media.matches ? 'dark' : 'light';
  }
  function applyBrand(brand) {
    if (!brand) return;
    theme = brand.theme || theme; applyTheme();
    logo.classList.toggle('relay-default-logo', !brand.logo);
    const source = brand.logo || 'logo.svg';
    if (logo.getAttribute('src') !== source) logo.src = source;
    orb.setAttribute('aria-label', '打开 ' + (brand.name || 'Relay') + ' 快捷对话');
  }
  function receiveState(state) {
    revision += 1;
    applyBrand(state && state.brand);
    orb.classList.toggle('is-running', !!(state && state.running));
    orb.title = state && state.running ? '正在执行 · 点击查看快捷对话' : '打开快捷对话 · 拖动调整位置';
  }
  function resetLight() {
    if (lightFrame) cancelAnimationFrame(lightFrame);
    lightFrame = 0; lightPoint = null;
    orb.style.removeProperty('--light-x'); orb.style.removeProperty('--light-y');
  }
  function moveLight(event) {
    if (pointer || motionMedia.matches || event.pointerType === 'touch') return;
    const bounds = orb.getBoundingClientRect();
    lightPoint = {
      x: 24 + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * 42,
      y: 16 + Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) * 38,
    };
    if (lightFrame) return;
    lightFrame = requestAnimationFrame(() => {
      lightFrame = 0;
      if (!lightPoint) return;
      orb.style.setProperty('--light-x', lightPoint.x.toFixed(1) + '%');
      orb.style.setProperty('--light-y', lightPoint.y.toFixed(1) + '%');
    });
  }
  orb.addEventListener('pointerenter', moveLight);
  orb.addEventListener('pointermove', moveLight);
  orb.addEventListener('pointerleave', resetLight);
  orb.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    suppressClick = false;
    resetLight();
    pointer = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
    orb.setPointerCapture(event.pointerId);
    invoke('orbDrag', { phase: 'start' });
  });
  orb.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!pointer.moved && Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) < 5) return;
    pointer.moved = true;
    orb.classList.add('is-dragging');
    invoke('orbDrag', { phase: 'move' });
  });
  function finishPointer(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    suppressClick = pointer.moved;
    pointer = null; orb.classList.remove('is-dragging');
    invoke('orbDrag', { phase: 'end' });
    if (orb.hasPointerCapture(event.pointerId)) orb.releasePointerCapture(event.pointerId);
  }
  orb.addEventListener('pointerup', finishPointer);
  orb.addEventListener('pointercancel', finishPointer);
  orb.addEventListener('lostpointercapture', finishPointer);
  orb.addEventListener('click', (event) => {
    if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
    invoke('toggle');
  });
  orb.addEventListener('contextmenu', (event) => { event.preventDefault(); invoke('orbMenu'); });
  media.addEventListener('change', applyTheme);
  motionMedia.addEventListener('change', resetLight);
  if (typeof api.onState === 'function') {
    const unsubscribe = api.onState(receiveState);
    if (typeof unsubscribe === 'function') off.push(unsubscribe);
  }
  if (typeof api.state === 'function') {
    const initialRevision = revision;
    Promise.resolve(api.state()).then((state) => { if (initialRevision === revision) receiveState(state); }).catch(() => {});
  }
  if (typeof api.brand === 'function') Promise.resolve(api.brand()).then(applyBrand).catch(() => {});
  window.addEventListener('beforeunload', () => { resetLight(); media.removeEventListener('change', applyTheme); motionMedia.removeEventListener('change', resetLight); off.forEach((fn) => fn()); }, { once: true });
})();
