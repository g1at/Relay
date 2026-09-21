// Overlay for workspace-navigation-smoke.cjs. Every operation is in memory.
// This script runs after ui-api-fixture.js and before the real renderer scripts.
(() => {
  const base = window.api;
  const copy = value => JSON.parse(JSON.stringify(value));
  let settings = { app: { theme: 'light', permissionMode: 'default' }, claude: { routes: uiFixture.routes, defaultModel: 'opus' }, info: { uiVersion: '2.1.0' } };
  let brandName = 'Relay', pmName = 'PM', brandRevision = 1;
  let update = { state: 'idle', current: '2.1.0', latest: '', checkedAt: 0, progress: 0 };
  const tasks = [{
    id: 'workspace-schedule', name: '导航验收简报', enabled: true, catchUp: true,
    schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
    action: { type: 'chat', prompt: '汇总示例项目进度。', model: 'haiku', memory: 'read', mode: 'plain' },
    delivery: { notify: true, saveToHistory: true }, nextRunAt: '2026-09-10T01:00:00.000Z',
  }];
  const state = window.workspaceFixture = {
    settingsReads: 0, settingsWrites: [], schedulerWrites: [], updateCalls: [], openedFiles: [], failNextDownload: false,
    settingsWriteMode: 'ok', releaseSettingsSave: null, brandWrites: [], pmWrites: [], providerWrites: [],
    savedSettings: () => copy(settings),
    setUpdate(patch) { update = { ...update, ...patch }; uiFixture.emit('relayUpdate.onEvent', copy(update)); },
  };
  const overrides = {
    settings: {
      read: async () => { state.settingsReads++; return copy(settings); },
      write: async value => {
        state.settingsWrites.push(copy(value));
        if (state.settingsWriteMode === 'refuse') return { ok: false, message: '模拟保存被拒绝' };
        if (state.settingsWriteMode === 'reject') throw new Error('模拟保存异常');
        const commit = () => { settings = { ...settings, app: { ...settings.app, ...value.app }, claude: { ...settings.claude, ...value.claude } }; return { ok: true }; };
        if (state.settingsWriteMode === 'hold') return new Promise(resolve => { state.releaseSettingsSave = () => { state.releaseSettingsSave = null; resolve(commit()); }; });
        return commit();
      },
    },
    brand: new Proxy({}, { get(_target, key) {
      if (key === 'get') return async () => ({ name: brandName, nameMax: 40, revision: String(brandRevision), logo: null });
      if (key === 'saveProfile') return async value => { state.brandWrites.push(value.name); brandName = value.name; brandRevision++; return {ok:true,name:brandName,logo:null,nameMax:40,revision:String(brandRevision)}; };
      if (key === 'discardLogoPreview') return async () => ({ok:true});
      if (key === 'setName') return async value => { state.brandWrites.push(value); brandName = value; return { ok: true }; };
      return base.brand[key];
    } }),
    pm: new Proxy({}, { get(_target, key) {
      if (key === 'get') return async () => ({ name: pmName });
      if (key === 'setName') return async value => { state.pmWrites.push(value); pmName = value; return { ok: true }; };
      return base.pm[key];
    } }),
    providers: new Proxy({}, { get(_target, key) {
      if (key === 'list') return async () => ({ ok: true, routes: copy(uiFixture.routes), profiles: [{
        id: 'fixture', name: '导航示例服务', baseUrl: 'https://models.example.invalid/v1', enabled: true,
        models: { haiku: 'vendor/mimo-v2.5-pro[1m]', sonnet: 'vendor/mimo-x-flash-preview', opus: 'vendor/mimo-x-pro-preview' },
        activeTiers: ['haiku', 'sonnet', 'opus'], activeImageAdapters: [], routed: true,
        hasCredential: false, chatReady: false, chatModelCount: 3, imageReady: false, imageModels: [],
      }] });
      if (key === 'create' || key === 'update') return async (...args) => { state.providerWrites.push(copy(args)); return { ok: true }; };
      if (key === 'discoverModels' || key === 'discoverDraftModels') return async () => ({ ok: true, models: [], modelCatalog: [], imageModels: [] });
      return base.providers[key];
    } }),
    library: {
      listImages: async () => ({ ok: true, items: [] }),
      listFiles: async () => ({ ok: true, items: Array.from({ length: 24 }, (_, i) => ({
        path: `C:\\relay-navigation-fixture\\导航说明-${i + 1}.md`, name: `导航说明-${i + 1}.md`, ext: 'md', type: 'document', size: 2048 + i, mtime: 1789000000000 - i * 60000,
      })) }),
      openFile: async path => { state.openedFiles.push(path); return { ok: true }; },
      openImagesDir: async () => ({ ok: true }),
      deleteImage: async () => ({ ok: true }),
    },
    scheduler: new Proxy({}, {
      get(_target, key) {
        if (key === 'list') return async () => ({ ok: true, items: copy(tasks) });
        if (key === 'preview') return async () => ({ ok: true, nextRunAt: '2026-09-10T01:00:00.000Z' });
        if (key === 'update') return async (id, patch) => { state.schedulerWrites.push({ id, patch: copy(patch) }); const task = tasks.find(item => item.id === id); Object.assign(task, copy(patch)); return { ok: true, item: copy(task), task: copy(task) }; };
        return base.scheduler[key];
      },
    }),
    relayUpdate: {
      onEvent: handler => base.relayUpdate.onEvent(handler),
      status: async () => { state.updateCalls.push('status'); return copy(update); },
      check: async () => { state.updateCalls.push('check'); state.setUpdate({ state: 'available', latest: '2.2.0', error: '' }); return copy(update); },
      download: async () => {
        state.updateCalls.push('download');
        if (state.failNextDownload) { state.failNextDownload = false; return { ok: false, error: '模拟下载请求失败' }; }
        state.setUpdate({ state: 'downloading', progress: 0, error: '' }); return { ok: true };
      },
      quitAndInstall: async () => { state.updateCalls.push('install'); return { ok: true }; },
      dismiss: async () => { state.updateCalls.push('dismiss'); return { ok: true }; },
    },
  };
  window.api = new Proxy(base, { get(target, key) { return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : target[key]; } });
})();
