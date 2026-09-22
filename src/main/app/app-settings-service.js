'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createAppSettingsCache } = require("./app-settings-cache");
const { normalizeAppPermissionMode } = require("../tasks/interaction-broker");

function createAppSettingsService({
  getUserDataDir, providerStore, onWrite = () => {},
}) {
  const appSettingsCache = createAppSettingsCache();
  function settingsPath() { return path.join(os.homedir(), '.claude', 'settings.json'); }
  function appSettingsPath() { return path.join(getUserDataDir(), 'app-settings.json'); }

  const PROVIDER_ISOLATION_SETTINGS_VERSION = 1;
  const IMAGE_PROVIDER_MIGRATION_VERSION = 1;
  const LEGACY_IMAGE_MODELS = Object.freeze([
    { adapterId: 'gpt-image-2', remoteModelId: 'azure_openai/gpt-image-2' },
    { adapterId: 'seedream-5.0', remoteModelId: 'volcengine_maas/Doubao-Seedream-5.0-lite' },
    { adapterId: 'seedream-4.5', remoteModelId: 'volcengine_maas/Doubao-Seedream-4.5' },
  ]);

  // 外部 Claude 配置从此只读：用于一次性迁移和兼容 Git Bash / MCP 资源，
  // Relay 的 API、模型与行为设置不再写回这个文件。
  function readLegacyClaudeSettings() {
    const f = settingsPath();
    if (!fs.existsSync(f)) return {};
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { console.error('[settings] 外部 Claude 配置解析失败:', e.message); return {}; }
  }
  function readAppSettings() {
    const f = appSettingsPath();
    const hasExistingSettings = fs.existsSync(f);
    let settings = {
      permissionMode: 'default',
      providerIsolationSettingsVersion: 0,
      firstRunSetupVersion: 0,
    };
    try {
      if (hasExistingSettings) {
        const parsed = appSettingsCache.read(f);
        settings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : settings;
      }
      let changed = false;
      if (settings.sdkMemoryMode !== 'relay' || settings.sdkAutoDreamEnabled !== false) {
        settings.sdkMemoryMode = 'relay'; settings.sdkAutoDreamEnabled = false; changed = true;
      }
      const permissionMode = normalizeAppPermissionMode(settings.permissionMode, { hasExistingSettings });
      if (settings.permissionMode !== permissionMode) {
        settings.permissionMode = permissionMode;
        changed = true;
      }
      if (settings.providerIsolationSettingsVersion !== PROVIDER_ISOLATION_SETTINGS_VERSION) {
        // 历史图像 Key 也移入同一系统密钥仓，不再以明文留在 app-settings.json。
        if (settings.imageApi && typeof settings.imageApi.apiKey === 'string' && settings.imageApi.apiKey.trim()) {
          providerStore.setAppSecret('image-api-key', settings.imageApi.apiKey);
          delete settings.imageApi.apiKey;
        }
        settings.providerIsolationSettingsVersion = PROVIDER_ISOLATION_SETTINGS_VERSION;
        changed = true;
      }
      if (settings.imageProviderMigrationVersion !== IMAGE_PROVIDER_MIGRATION_VERSION) {
        try {
          const legacyImage = settings.imageApi && typeof settings.imageApi === 'object'
            ? settings.imageApi
            : {};
          const legacyKey = providerStore.getAppSecret('image-api-key');
          if (legacyImage.baseUrl && legacyKey) {
            providerStore.migrateLegacyImageProvider({
              baseUrl: legacyImage.baseUrl,
              apiKey: legacyKey,
              imageModels: LEGACY_IMAGE_MODELS,
            });
          }
          delete settings.imageApi;
          providerStore.deleteAppSecret('image-api-key');
          settings.imageProviderMigrationVersion = IMAGE_PROVIDER_MIGRATION_VERSION;
          changed = true;
        } catch (error) {
          // 保留旧配置与迁移标记，下次启动可继续尝试，避免静默丢失可用凭据。
          console.warn('[settings] 旧版图像配置迁移失败: %s', error.message);
        }
      }
      if (changed) {
        try { writeAppSettings(settings); }
        catch (error) { console.warn('[settings] Relay 私有设置迁移写入失败: %s', error.message); }
      }
      return settings;
    }
    catch (e) {
      console.error('[settings] app-settings 解析失败: %s', e.message);
      return {
        permissionMode: 'default',
        providerIsolationSettingsVersion: PROVIDER_ISOLATION_SETTINGS_VERSION,
        imageProviderMigrationVersion: IMAGE_PROVIDER_MIGRATION_VERSION,
        firstRunSetupVersion: 0,
      };
    }
  }
  function writeAppSettings(data) {
    data = { ...data, sdkMemoryMode: 'relay', sdkAutoDreamEnabled: false };
    const f = appSettingsPath();
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, f);
    appSettingsCache.invalidate();
    onWrite();
  }


  return { readAppSettings, writeAppSettings, readLegacyClaudeSettings };
}

module.exports = { createAppSettingsService };
