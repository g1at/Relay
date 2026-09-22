'use strict';

const { normalizePreferences } = require('./general-preferences');

// Own Electron startup and the sequential durable quit barriers. Runtime maps
// belong to bootstrap; this controller only drains/releases those same owners.
function registerApplicationLifecycle({
  app, BrowserWindow, nativeTheme, powerMonitor, Notification, globalShortcut,
  windows, updater, scheduler, settings, history, taskRuntime, mini, memory,
  integrations, initializeScheduler, getSkillDraftService,
  getUsageStatsService, getExistingUsageStatsService, HAS_SINGLE_INSTANCE_LOCK,
}) {
  const { currentAppIcon, updateNativeBrandTheme, decideStartup, showMainWindow } = windows;
  const handlePowerResume = () => {
    try { scheduler.onResume(); }
    catch (error) { console.warn('[scheduler] 系统恢复后重排失败: %s', error.message); }
  };
  let skillDraftShutdownPending = false;
  let skillDraftShutdownComplete = false;
  let miniShutdownPending = false;
  let miniShutdownComplete = false;
  let usageShutdownPending = false;
  let usageShutdownComplete = false;
  let progressShutdownPending = false;
  let progressShutdownComplete = false;
  app.whenReady().then(() => {
    if (!HAS_SINGLE_INSTANCE_LOCK) return;
    taskRuntime.applyParallelTaskLimit(normalizePreferences(settings.read()).maxParallelTasks);
    nativeTheme.on('updated', updateNativeBrandTheme);
    app.once('will-quit', () => {
      nativeTheme.removeListener('updated', updateNativeBrandTheme);
      windows.disposeNativeTheme();
    });
    // ⚡ 首屏优先:先建窗(decideStartup 快速路径同步命中即零延迟),其余维护任务全推到窗口之后,
    //   避免同步文件 I/O 在窗口创建前阻塞主线程,导致"按钮要等一下才能点"。
    decideStartup();
    if (!windows.mainWindow) taskRuntime.scheduleRetention();
    updateNativeBrandTheme();
    // 两个一次性/幂等迁移推到窗口创建之后的后台跑(不挡首屏;数据量小,延后无副作用)。
    //   migrateHistoryV1 在无旧 history.json 时瞬间 return;migrateScheduledTitles 全量扫历史索引,
    //   故都延后,且后者本就只为洗很久前的 ⏰ 前缀,绝大多数启动无命中。
    setTimeout(() => {
      try { history.migrateHistoryV1(); } catch (e) { console.warn('[startup] 历史迁移 V1 失败: %s', e.message); }
      try { history.migrateScheduledTitles(); } catch (e) { console.warn('[startup] 定时标题迁移失败: %s', e.message); }
    }, 800);
    // 启动调度器：延后一拍,让窗口首帧 + 渲染层启动 IPC(settings/brand/history)先走,
    //   scheduler.init 读 schedules.json + 注册 cron 不挤占首屏。错过补跑本就在其内部再延后。
    setTimeout(() => { try { initializeScheduler(); } catch (e) { console.error('[scheduler] 启动失败', e); } }, 300);
    // 应用自更新:打包版才生效(内部有 isPackaged 守卫);首查在其内部再延迟 3 分钟,不影响首屏。
    try {
      updater.init({
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        markQuitting: () => { windows.markQuitting(); },
        getMainWindow: () => windows.mainWindow,
        notify: ({ title, body }) => {
          try {
            if (Notification.isSupported()) {
              new Notification({ title: title || 'Relay', body: body || '', icon: currentAppIcon() || undefined }).show();
            } else if (windows.tray) {
              windows.tray.displayBalloon({ icon: currentAppIcon() || undefined, title: title || 'Relay', content: body || '' });
            }
          } catch (_) {}
        },
      });
    } catch (e) { console.error('[updater] 启动失败:', e.message); }
    // 技能用量不再在启动阶段预热；首次打开技能页时先显示持久化快照，再由 Worker 增量校准。
    // 全局快捷键唤起迷你输入框(Alt+Space)。注册失败不影响主功能,托盘菜单仍可唤起。
    mini.registerShortcut();
    mini.getOrCreateHost().start();
    // 窗口先显示，统计在后台预热；首次打开用量页无需等待历史重读。
    const usageWarmup = setTimeout(() => {
      if (!windows.isQuitting) getUsageStatsService().refresh().catch(() => {});
    }, 1800);
    usageWarmup.unref?.();
    try { powerMonitor.on('resume', handlePowerResume); }
    catch (e) { console.warn('[scheduler] 无法监听系统恢复事件: %s', e.message); }
  });
  app.on('window-all-closed', () => {
    // 主窗口现在「关闭=隐藏到托盘」,不会触发本事件;此处只在真正退出(windows.isQuitting)
    //   或仅有向导窗口被关时走到。托盘存活且非退出意图时,保持进程驻留让后台任务继续跑。
    if (!windows.isQuitting && windows.tray) return;
    // 杀掉所有在跑的 claude 子进程(含常驻会话 —— 它们不会自己退,漏杀就是每个 ~630MB 的孤儿)
    for (const [, child] of taskRuntime.jobs) { try { child.kill('SIGTERM'); } catch (_) {} }
    taskRuntime.jobs.clear();
    for (const sess of [...taskRuntime.liveSessions.values()]) taskRuntime.killLiveSession(sess, '应用退出');
    if (process.platform !== 'darwin') app.quit();
  });
  // 退出前兜底清理:无论从哪条路径退出,都确保子进程被杀、托盘被销毁(否则托盘图标残留)
  app.on('before-quit', event => {
    windows.markQuitting();
    if (getSkillDraftService() && !skillDraftShutdownComplete) {
      event.preventDefault();
      if (!skillDraftShutdownPending) {
        skillDraftShutdownPending = true;
        getSkillDraftService().close().catch(error => console.warn('[skill-draft] 退出排空失败:', error.message)).finally(() => {
          skillDraftShutdownComplete = true;
          app.quit();
        });
      }
      return;
    }
    if (mini.getChat() && !miniShutdownComplete) {
      event.preventDefault();
      if (!miniShutdownPending) {
        miniShutdownPending = true;
        Promise.resolve(mini.getChat().shutdown()).catch(error => console.warn('[mini] 保存退出状态失败:', error.message)).finally(() => {
          miniShutdownComplete = true;
          app.quit();
        });
      }
      return;
    }
    if (getExistingUsageStatsService() && !usageShutdownComplete) {
      event.preventDefault();
      if (!usageShutdownPending) {
        usageShutdownPending = true;
        Promise.resolve(getExistingUsageStatsService().destroy()).catch(error => console.warn('[usage] 保存退出状态失败:', error.message)).finally(() => {
          usageShutdownComplete = true;
          app.quit();
        });
      }
      return;
    }
    if (taskRuntime.getProgressStore() && !progressShutdownComplete) {
      event.preventDefault();
      if (!progressShutdownPending) {
        progressShutdownPending = true;
        taskRuntime.flushStreams();
        taskRuntime.getProgressStore().close().catch(error => console.warn('[task-progress] 保存退出进度失败:', error.message)).finally(() => {
          progressShutdownComplete = true;
          app.quit();
        });
      }
      return;
    }
    try { if (mini.getChat()) mini.getChat().destroy(); } catch (_) {}
    try { if (mini.getHost()) mini.getHost().destroy(); } catch (_) {}
    integrations.attachmentDialog.dispose();
    integrations.browserPanelTools.dispose();
    try { integrations.workspaceTools.dispose(); } catch (e) { console.warn('[workspace] 退出清理失败: %s', e.message); }
    try { taskRuntime.interactions.close({ message: 'Relay 正在退出，等待中的操作已安全拒绝', interrupt: true }); }
    catch (e) { console.warn('[interaction] 退出清理失败: %s', e.message); }
    taskRuntime.flushStreams();
    taskRuntime.flushEvents();
    if (memory.hasPendingUsage()) memory.flushUsage();
    try { scheduler.shutdown(); } catch (e) { console.warn('[scheduler] 退出清理失败: %s', e.message); }
    try { if (taskRuntime.getOrchestrator()) taskRuntime.getOrchestrator().shutdown(); }
    catch (e) { console.warn('[task-orchestrator] 退出清理失败: %s', e.message); }
    for (const lease of taskRuntime.resourceLeases.values()) {
      try { lease.release(); } catch (_) {}
    }
    taskRuntime.resourceLeases.clear();
    taskRuntime.interruptActiveRuns('Relay exited before the task completed');
    try { if (taskRuntime.getLedger() && typeof taskRuntime.getLedger().flush === 'function') taskRuntime.getLedger().flush(); } catch (_) {}
    for (const [, child] of taskRuntime.jobs) { try { child.kill('SIGTERM'); } catch (_) {} }
    taskRuntime.jobs.clear();
    for (const sess of [...taskRuntime.liveSessions.values()]) taskRuntime.killLiveSession(sess, '应用退出');
    try { globalShortcut.unregisterAll(); } catch (_) {}   // 释放全局快捷键,避免残留占用
    try { powerMonitor.removeListener('resume', handlePowerResume); } catch (_) {}
    windows.destroyTray();
  });
  app.on('activate', () => {
    // 有主窗口(可能只是被隐藏)就恢复它;否则按启动逻辑重建
    if (windows.mainWindow && !windows.mainWindow.isDestroyed()) showMainWindow();
    else if (BrowserWindow.getAllWindows().length === 0) decideStartup();
  });

  return { isUsageClosed: () => usageShutdownComplete };
}

module.exports = { registerApplicationLifecycle };
