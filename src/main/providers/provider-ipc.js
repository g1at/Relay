'use strict';

const { testProviderConnection, createProviderDraftRuntime, discoverProviderModels } = require("./provider-connectivity");

const { retryProviderWrite, providerWriteFailure } = require('./provider-write-retry');

function registerProviderIpc({
  ipcMain, providerStore, publishProviderChange, writeRetrySleep,
}) {
  // Keep user writes ordered while yielding to the event loop during backoff.
  // Each attempt calls the store again so it reads the latest committed state.
  let writeQueue = Promise.resolve();
  const write = operation => {
    const pending = writeQueue.then(() => retryProviderWrite(operation, { sleep: writeRetrySleep }));
    writeQueue = pending.catch(() => {});
    return pending;
  };
  const notify = (...args) => {
    try { publishProviderChange(...args); }
    catch (error) {
      // Notification failure cannot turn a committed write into a failed save.
      try { (providerStore.logger || console).warn('[provider] 配置已保存，通知更新失败: %s', error.message); } catch (_) {}
    }
  };
  const currentRevision = (id, revision, message) => {
    const current = providerStore.getProfile(id);
    if (!current || Number(current.revision) !== Number(revision)) {
      const error = new Error(message);
      error.code = 'PROVIDER_RESULT_STALE';
      throw error;
    }
    return current;
  };

  ipcMain.handle('providers:list', () => ({
    ok: true,
    profiles: providerStore.listProfiles(),
    routes: providerStore.getRoutingView(),
  }));

  ipcMain.handle('providers:mediaPresets', () => ({ ok: true, ...providerStore.getMediaProtocolPresets() }));
  ipcMain.handle('providers:listMediaModels', (_event, options = {}) => ({
    ok: true, models: providerStore.listMediaModels({ modality: options && options.modality }),
  }));

  ipcMain.handle('providers:create', async (_event, input = {}) => {
    try {
      const result = await write(() => providerStore.createProfile(input));
      notify('新增', { runtimeChanged: !!result.chatRoutesChanged });
      return { ok: true, ...result };
    } catch (error) {
      return providerWriteFailure(error);
    }
  });

  ipcMain.handle('providers:update', async (_event, { id, patch } = {}) => {
    try {
      let before;
      const result = await write(() => {
        before = providerStore.getProfile(id);
        return providerStore.updateProfile(id, patch || {});
      });
      notify('更新', {
        runtimeChanged: !!(result.chatRoutesChanged
          || (before && before.activeTiers && before.activeTiers.length && result.runtimeChanged)),
      });
      return { ok: true, ...result };
    } catch (error) {
      return providerWriteFailure(error);
    }
  });

  ipcMain.handle('providers:duplicate', async (_event, id) => {
    try {
      const result = await write(() => providerStore.duplicateProfile(id));
      notify('复制');
      return { ok: true, ...result };
    } catch (error) {
      return providerWriteFailure(error);
    }
  });

  ipcMain.handle('providers:remove', async (_event, id) => {
    try {
      const result = await write(() => providerStore.removeProfile(id));
      notify('删除');
      return { ok: true, ...result };
    } catch (error) {
      return providerWriteFailure(error);
    }
  });

  ipcMain.handle('providers:setImageRoute', async (_event, { adapterId, id } = {}) => {
    try {
      const result = await write(() => providerStore.setImageRoute(adapterId, id || null));
      if (result.changed) notify('切换图像模型');
      return { ok: true, ...result };
    } catch (error) {
      return providerWriteFailure(error);
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
      const stored = await write(() => {
        currentRevision(id, runtime.revision, '服务商配置已变更，请重新检测');
        return providerStore.setAuthMode(id, result.authMode);
      });
      if (stored.changed) {
        notify('Anthropic 认证方式更新', {
          runtimeChanged: !!(before.activeTiers && before.activeTiers.length),
        });
      }
      return { ...result, scope: 'saved', profile: stored.profile };
    } catch (error) {
      return { ...providerWriteFailure(error, '连接检测失败'), scope: 'saved', ...(error.code === 'PROVIDER_RESULT_STALE' ? { stale: true } : {}) };
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
    let discovered = {}, auth = { changed: false }, stored = null, before = null;
    try {
      const runtime = providerStore.getConnectionRuntime(id);
      if (!runtime) return { ok: false, models: [], message: '该服务商尚未配置 Base URL 或 API Key' };
      // Fetch once. Only local persistence is eligible for retry.
      discovered = await discoverProviderModels(runtime);
      const imageModels = Array.isArray(discovered.imageModels) ? discovered.imageModels : [];
      const models = Array.isArray(discovered.models) ? discovered.models : [];
      let revision = runtime.revision;
      const guard = () => currentRevision(id, revision, '服务商配置已变更，请重新获取模型目录');
      before = guard();
      // A shared gateway directory does not establish Claude's auth mode.
      if (discovered.ok && discovered.authMode && !discovered.gatewayRootFallbackUsed) {
        auth = await write(() => {
          guard();
          return providerStore.setAuthMode(id, discovered.authMode);
        });
        // Follow our own committed auth revision, never an unrelated edit.
        revision = auth.profile?.revision ?? revision;
      }
      stored = await write(() => {
        guard();
        return providerStore.setDiscoveredImageModels(id, discovered.ok ? imageModels : null, {
          status: discovered.ok ? (imageModels.length ? 'ready' : 'none') : 'error',
          message: discovered.message,
          modelCount: Number(discovered.totalModels) || models.length,
          claimUnassignedRoutes: false,
        });
      });
      // Directory refresh never replaces explicit media bindings.
      const media = discovered.ok && typeof providerStore.setMediaCatalog === 'function'
        ? await write(() => {
          guard();
          return providerStore.setMediaCatalog(id, discovered.mediaCandidates || discovered.mediaModels || discovered.modelCatalog || []);
        }) : null;
      return { ...discovered, profile: media ? media.profile : stored.profile };
    } catch (error) {
      if (error.code === 'PROVIDER_RESULT_STALE') {
        return { ...discovered, ok: false, stale: true, models: [], modelCatalog: [], imageModels: [], mediaModels: [], mediaCandidates: [], totalModels: 0, message: error.message };
      }
      return { ...discovered, ...providerWriteFailure(error, '模型目录更新失败') };
    } finally {
      // Earlier writes may have committed even if a later catalog write failed.
      if (stored?.routesChanged || auth.changed) {
        notify(auth.changed ? 'Anthropic 认证与模型能力更新' : '图像能力更新', {
          runtimeChanged: !!(auth.changed && before?.activeTiers?.length),
        });
      }
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
