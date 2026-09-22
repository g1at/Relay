'use strict';


function registerSchedulerIpc({
  ipcMain, app, scheduler, maybeAskAutostart, readAppSettings, setAutoLaunch,
}) {

  ipcMain.handle('sched:list',   () => ({ ok: true, items: scheduler.list() }));
  ipcMain.handle('sched:runs', (_e, id) => ({ ok: true, items: scheduler.runs(typeof id === 'string' ? id : undefined) }));
  ipcMain.handle('sched:create', async (_e, task) => {
    const r = scheduler.create(task);
    // 首个任务创建成功后，问一次开机自启
    try { if (r.ok && scheduler.list().length === 1) await maybeAskAutostart(); } catch (e) { console.warn('[sched] autostart 检查失败: %s', e.message); }
    return r;
  });
  ipcMain.handle('sched:update', (_e, { id, patch }) => scheduler.update(id, patch));
  ipcMain.handle('sched:remove', (_e, id) => scheduler.remove(id));
  ipcMain.handle('sched:toggle', (_e, { id, enabled }) => scheduler.toggle(id, enabled));
  ipcMain.handle('sched:runNow', async (_e, id) => await scheduler.runNow(id));
  ipcMain.handle('sched:preview', (_e, schedule) => ({ ok: true, times: scheduler.preview(schedule) }));
  // 开机自启开关（设置页用）
  ipcMain.handle('sched:getAutoLaunch', () => {
    try {
      const s = app.getLoginItemSettings({ args: ['--autostart'] });
      return { ok: true, enabled: !!s.openAtLogin };
    } catch (e) { console.warn('[autostart] 读取注册表失败: %s', e.message); return { ok: true, enabled: !!readAppSettings().autoLaunch }; }
  });
  ipcMain.handle('sched:setAutoLaunch', (_e, enabled) => { setAutoLaunch(enabled); return { ok: true }; });


}

module.exports = { registerSchedulerIpc };
