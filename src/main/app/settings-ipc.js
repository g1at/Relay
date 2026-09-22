'use strict';

const { normalizePreferences } = require('./general-preferences');
const { isQuickChatEnabled, normalizeQuickChatPatch } = require('./mini-window-host');
const { isAppPermissionMode } = require('../tasks/interaction-broker');

function registerSettingsIpc({
  ipcMain, app, providerStore, readAppSettings, writeAppSettings, generalPreferences,
  windows, applyParallelTaskLimit, publishProviderChange,
  onEnvironmentChanged, onQuickChatChanged, refreshMiniBrand,
}) {
  ipcMain.handle('settings:read', () => {
    const provider = providerStore.getSettingsView();
    const a = readAppSettings();
    return {
      claude: {
        // 密钥不回传 renderer；当前设置页以“留空表示不修改”兼容。
        apiKey:        '',
        hasApiKey:     provider.hasCredential,
        apiKeyHint:    provider.credentialHint,
        baseUrl:       provider.baseUrl || '',
        opusModel:     provider.models.opus || '',
        sonnetModel:   provider.models.sonnet || '',
        haikuModel:    provider.models.haiku || '',
        defaultModel:  provider.defaultModel || 'haiku',
        providerId: provider.id,
        providerRevision: provider.revision,
        routes: provider.routes,
        isolated: true,
      },
      app: {
        ...normalizePreferences(a),
        allowCommandTasks: !!a.allowCommandTasks,   // 命令类定时任务总开关（默认关）
        quickChatEnabled: isQuickChatEnabled(a),
        miniInputEnabled: isQuickChatEnabled(a), // 兼容旧版设置读取
        floatingOrbEnabled: isQuickChatEnabled(a),
        conversationIndex: a.conversationIndex !== false, // 对话快捷索引（默认开；仅显式 false 才关）
        showContextUsage: a.showContextUsage !== false,
        theme: a.theme || 'light',
        skillMaintenanceModel: ['haiku', 'sonnet', 'opus'].includes(a.skillMaintenanceModel) ? a.skillMaintenanceModel : '',
        memoryMaintenanceModel: ['haiku', 'sonnet', 'opus'].includes(a.memoryMaintenanceModel) ? a.memoryMaintenanceModel : '',
      },
      info: {
        uiVersion:    app.getVersion ? app.getVersion() : 'dev',
      },
    };
  });

  ipcMain.handle('settings:write', async (_e, payload = {}) => {
    let preferencePatch;
    try { preferencePatch = { ...await generalPreferences.validatePatch(payload.app || {}), ...normalizeQuickChatPatch(payload.app || {}) }; }
    catch (error) { return { ok: false, code: error.code, message: error.message }; }
    const a = readAppSettings();
    const previousEnvironment = normalizePreferences(a).agentEnvironment;
    if (payload.app && Object.hasOwn(payload.app, 'permissionMode')
        && !isAppPermissionMode(payload.app.permissionMode)) {
      return { ok: false, message: '权限模式无效' };
    }
    let defaultModelChange = null;
    if (payload.claude && Object.hasOwn(payload.claude, 'defaultModel')) {
      try { defaultModelChange = providerStore.setDefaultModel(payload.claude.defaultModel); }
      catch (error) { return { ok: false, message: error.message }; }
    }
    if (payload.app) {
      const appPatch = { ...payload.app, ...preferencePatch };
      delete appPatch.defaultModel;
      delete appPatch.permissionMode;
      delete appPatch.conversationPermissions;
      delete appPatch.skipDangerousPrompt;
      Object.assign(a, appPatch);
      // 主题切换 → 同步 Electron nativeTheme + 窗口背景色
      if (payload.app.theme) windows.applyTheme(payload.app.theme);
    }
    delete a.defaultModel;
    try { writeAppSettings(a); }
    catch (error) {
      const prefix = defaultModelChange && defaultModelChange.changed
        ? '默认档位已保存，其他本地偏好保存失败：'
        : '本地偏好保存失败：';
      return { ok: false, message: prefix + error.message };
    }
    if (payload.app?.theme) windows.updateNativeBrandTheme();
    if (Object.hasOwn(preferencePatch, 'maxParallelTasks')) applyParallelTaskLimit(preferencePatch.maxParallelTasks);
    if (defaultModelChange && defaultModelChange.changed) publishProviderChange('更新默认档位');
    if (previousEnvironment !== normalizePreferences(a).agentEnvironment) {
      onEnvironmentChanged();
    }
    // Apply after persistence so shortcuts and window visibility read the new values.
    if (Object.hasOwn(preferencePatch, 'quickChatEnabled')) {
      onQuickChatChanged();
    }
    refreshMiniBrand();
    return { ok: true,
      ...(defaultModelChange ? { routes: providerStore.getRoutingView() } : {}) };
  });


}

module.exports = { registerSettingsIpc };
