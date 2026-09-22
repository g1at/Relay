'use strict';

const { testProviderConnection, createProviderDraftRuntime, discoverProviderModels } = require("./provider-connectivity");

function registerProviderIpc({
  ipcMain, providerStore, publishProviderChange,
}) {

  ipcMain.handle('providers:list', () => ({
    ok: true,
    profiles: providerStore.listProfiles(),
    routes: providerStore.getRoutingView(),
  }));

  ipcMain.handle('providers:create', (_event, input = {}) => {
    try {
      const result = providerStore.createProfile(input);
      publishProviderChange('新增', { runtimeChanged: !!result.chatRoutesChanged });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('providers:update', (_event, { id, patch } = {}) => {
    try {
      const before = providerStore.getProfile(id);
      const result = providerStore.updateProfile(id, patch || {});
      publishProviderChange('更新', {
        runtimeChanged: !!(result.chatRoutesChanged
          || (before && before.activeTiers && before.activeTiers.length && result.runtimeChanged)),
      });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('providers:duplicate', (_event, id) => {
    try {
      const result = providerStore.duplicateProfile(id);
      publishProviderChange('复制');
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('providers:remove', (_event, id) => {
    try {
      const result = providerStore.removeProfile(id);
      publishProviderChange('删除');
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('providers:setImageRoute', (_event, { adapterId, id } = {}) => {
    try {
      const result = providerStore.setImageRoute(adapterId, id || null);
      if (result.changed) publishProviderChange('切换图像模型');
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('providers:test', async (_event, id) => {
    try {
      const runtime = providerStore.getRuntime(id);
      if (!runtime) return { ok: false, scope: 'saved', message: '该服务商尚未配置对话模型、Base URL 或 API Key' };
      const result = await testProviderConnection(runtime);
      const before = providerStore.getProfile(id);
      // A response from a previous URL/key/model must not update this profile's
      // auth mode or be shown as proof for a newly saved configuration.
      if (!before || Number(before.revision) !== Number(runtime.revision)) {
        return { ...result, ok: false, scope: 'saved', stale: true, message: '服务商配置已变更，请重新检测' };
      }
      if (!result.ok || !result.authMode) return { ...result, scope: 'saved', profile: before };
      const stored = providerStore.setAuthMode(id, result.authMode);
      if (stored.changed) {
        publishProviderChange('Anthropic 认证方式更新', {
          runtimeChanged: !!(before.activeTiers && before.activeTiers.length),
        });
      }
      return { ...result, scope: 'saved', profile: stored.profile };
    } catch (error) {
      return { ok: false, scope: 'saved', message: error.message || '连接检测失败' };
    }
  });

  ipcMain.handle('providers:testDraft', async (_event, draft = {}) => {
    try {
      const input = draft && typeof draft === 'object' ? draft : {};
      const existing = input.id ? providerStore.getConnectionRuntime(input.id) : null;
      const runtime = createProviderDraftRuntime(input, existing, { requireModel: true });
      return { ...await testProviderConnection(runtime), scope: 'draft', tier: runtime.tier };
    } catch (error) {
      return { ok: false, scope: 'draft', message: error.message || '连接检测失败' };
    }
  });

  ipcMain.handle('providers:discoverModels', async (_event, id) => {
    const runtime = providerStore.getConnectionRuntime(id);
    if (!runtime) return { ok: false, models: [], message: '该服务商尚未配置 Base URL 或 API Key' };
    const discovered = await discoverProviderModels(runtime);
    const imageModels = Array.isArray(discovered.imageModels) ? discovered.imageModels : [];
    const models = Array.isArray(discovered.models) ? discovered.models : [];
    try {
      const before = providerStore.getProfile(id);
      // Discovery is scoped to the URL/key/revision that started the request.
      // Do not let an old response restore capabilities after a key change.
      if (!before || Number(before.revision) !== Number(runtime.revision)) {
        return {
          ...discovered, ok: false, stale: true,
          models: [], modelCatalog: [], imageModels: [], totalModels: 0,
          message: '服务商配置已变更，请重新获取模型目录',
        };
      }
      // 同域根路径回退只用于读取共享模型目录；它可能是 OpenAI 风格目录，
      // 不能据此改变 Claude Messages 的认证方式。只有 Anthropic 主路径命中时才记忆认证。
      const auth = discovered.ok && discovered.authMode && !discovered.gatewayRootFallbackUsed
        ? providerStore.setAuthMode(id, discovered.authMode)
        : { changed: false };
      const stored = providerStore.setDiscoveredImageModels(
        id,
        discovered.ok ? imageModels : null,
        {
          status: discovered.ok
            ? (imageModels.length ? 'ready' : 'none')
            : 'error',
          message: discovered.message,
          modelCount: Number(discovered.totalModels) || models.length,
          claimUnassignedRoutes: false,
        },
      );
      if (stored.routesChanged || auth.changed) {
        publishProviderChange(
          auth.changed ? 'Anthropic 认证与模型能力更新' : '图像能力更新',
          { runtimeChanged: !!(auth.changed && before && before.activeTiers && before.activeTiers.length) },
        );
      }
      return { ...discovered, profile: stored.profile };
    } catch (error) {
      return { ...discovered, ok: false, message: error.message };
    }
  });

  ipcMain.handle('providers:discoverDraftModels', async (_event, draft = {}) => {
    try {
      const input = draft && typeof draft === 'object' ? draft : {};
      const existing = input.id ? providerStore.getConnectionRuntime(input.id) : null;
      return await discoverProviderModels(createProviderDraftRuntime(input, existing));
    } catch (error) {
      return { ok: false, models: [], message: error.message || '模型目录探测失败' };
    }
  });


}

module.exports = { registerProviderIpc };
