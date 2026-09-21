'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sliceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
};

test('打开旧历史会话的服务商迁移不刷新左侧排序时间', () => {
  const main = read('main.js');
  const preload = read('preload.js');
  const renderer = read('renderer/app.js');

  assert.match(preload, /invalidateSessionForProvider:[\s\S]{0,180}history:invalidateSessionForProvider/);

  const metadataPersist = sliceBetween(
    main,
    'function persistConversationRecord(conv)',
    '\nfunction saveConversation(conv)',
  );
  assert.match(metadataPersist, /writeJsonAtomic\(convFilePath\(conv\.id\), conv\)/);
  assert.match(metadataPersist, /writeHistoryIndex\(items\)/);
  assert.doesNotMatch(metadataPersist, /updatedAt\s*=/);
  assert.doesNotMatch(metadataPersist, /\.title\s*=/);

  const handler = sliceBetween(
    main,
    "ipcMain.handle('history:invalidateSessionForProvider'",
    "ipcMain.handle('history:save'",
  );
  assert.match(handler, /const c = loadConversation\(id\)/);
  assert.match(handler, /c\.sessionId = null/);
  assert.match(handler, /c\.carryContextOnNextTurn = 'provider'/);
  assert.match(handler, /providerStore\.getRoutingView\(\)\.chatRoutes/);
  assert.match(handler, /sessionRouteMatchesProvider\(currentRoute, target\)/);
  assert.match(handler, /persistConversationRecord\(c\)/);
  assert.doesNotMatch(handler, /new Date\s*\(/);
  assert.doesNotMatch(handler, /c\.updatedAt\s*=/);

  const genericSave = sliceBetween(
    main,
    "ipcMain.handle('history:save'",
    "ipcMain.handle('history:delete'",
  );
  assert.match(genericSave, /conv\.updatedAt = now/);

  const loadPath = sliceBetween(
    renderer,
    'async function loadConversation(',
    '\nfunction startNewConv(',
  );
  assert.match(loadPath, /invalidateConversationSessionForProvider\(conv, prespawnSessionRoute\.routeTier\)/);
  assert.match(renderer, /providerSessionInvalidationVersions\.get\(conv\) === requestVersion/);
  assert.match(renderer, /conv\.carryContextOnNextTurn === 'provider'/);
  assert.match(renderer, /returnedSessionMatchesCurrentRoute/);
  const loadMigration = sliceBetween(
    loadPath,
    'if (conv.sessionId && prespawnSessionRoute',
    '\n  if (!showChatView(',
  );
  assert.doesNotMatch(loadMigration, /history\.save\(/);

  const routingEvents = sliceBetween(
    renderer,
    'function initProviderRoutingEvents()',
    '\nfunction modelCapability(',
  );
  assert.match(routingEvents, /invalidateConversationSessionForProvider\(resettingConv, targetSessionRoute\.routeTier\)/);
  assert.doesNotMatch(routingEvents, /history\.save\(/);
});

test('原生提问和权限审批使用独立文档流决策面', () => {
  const html = read('renderer/index.html');
  const surface = read('renderer/interaction-surface.js');
  const css = read('renderer/interaction-surface.css');
  const preload = read('preload.js');
  const main = read('main.js');

  assert.match(html, /id="interactionSurfaceMount"/);
  const inputAreaAt = html.indexOf('class="input-area"');
  const interactionAt = html.indexOf('id="interactionSurfaceMount"');
  const inputCardAt = html.indexOf('class="input-card"');
  assert.ok(
    inputAreaAt >= 0 && inputAreaAt < interactionAt && interactionAt < inputCardAt,
    '决策面应位于输入区内部、输入卡上方，形成统一 composer stack',
  );
  assert.match(html, /interaction-surface\.css/);
  assert.match(html, /interaction-surface\.js/);
  assert.match(preload, /interactions:\s*\{/);
  assert.match(surface, /renderQuestion\(/);
  assert.match(surface, /renderPermission\(/);
  assert.doesNotMatch(surface, /\b(?:showToast|customConfirm|customPrompt)\s*\(/);
  assert.doesNotMatch(surface, /classList\.(?:add|toggle)\([^\n]*modal/);
  assert.match(css, /\.interaction-permission-card/);
  assert.match(css, /\.interaction-question-form/);
  assert.match(surface, /refreshPromise/);
  assert.ok(surface.includes('Basic\\s+'), '审批参数展示必须隐藏 Basic 凭据');
  assert.ok(surface.includes("[a-z][a-z0-9+.-]*:\\/\\/"), '审批参数展示必须隐藏 URL userinfo');
  assert.match(main, /interactionBroker\.rejectWindow\(win\.id/);
  assert.match(main, /waitingCount[\s\S]*需要你处理/);
  assert.match(surface, /查看完整参数（已脱敏）/);
  assert.match(surface, /permissionInputPreview\(/);
  assert.match(surface, /const decisionReason = redactDisplayText\(permission\.decisionReason\)/);
  assert.match(surface, /const suppliedTitle = redactDisplayText\(permission\.title\)/);
  assert.match(surface, /function cleanPermissionDescription[\s\S]{0,160}redactDisplayText\(value\)/);
  assert.match(surface, /function appendFact[\s\S]{0,180}const safeValue = redactDisplayText\(value\)/);
  assert.match(surface, /允许 Relay \$\{actionLabel\}吗？/);
  assert.match(surface, /允许一次/);
  assert.match(surface, /允许此对话/);
  assert.match(surface, /allow_session/);
  assert.doesNotMatch(surface, /更多操作|拒绝并停止/);
  assert.match(surface, /interaction-allow-menu-toggle/);
  assert.match(surface, /setAttribute\(['"]aria-busy['"]/);
  assert.match(surface, /state\.items\.get\(currentId\) === currentItem/);
  assert.match(surface, /setCurrentBusyState\(interaction, true\)/);
  assert.doesNotMatch(surface, /appendFact\(facts, ['"]工具['"]/);
  assert.doesNotMatch(surface, /interaction-permission-note/);
  const focusDecision = surface.slice(
    surface.indexOf('function focusDecision()'),
    surface.indexOf('function getDraft('),
  );
  assert.match(focusDecision, /interaction && interaction\.kind === ['"]question['"]/);
  assert.match(focusDecision, /:\s*ui\.title/);
  assert.doesNotMatch(focusDecision, /button:not/);
  assert.match(css, /\.interaction-surface\s*\{[^}]*max-width:\s*var\(--max-chat-w\)/s, '决策面与输入框采用同一个最大宽度');
  assert.match(css, /\.interaction-pager\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.input-area\s*\{\s*container-type:\s*inline-size/);
  assert.match(css, /@container\s*\(max-width:\s*560px\)/);
  assert.match(css, /\.interaction-permission-preview-code/);
  assert.match(css, /\.interaction-permission-input\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.interaction-permission-input summary\s*\{[^}]*width:\s*fit-content[^}]*display:\s*flex/s);
  assert.doesNotMatch(css, /\.interaction-permission-input\[open\]\s*\{[^}]*width:/s);
  assert.doesNotMatch(css, /\.interaction-permission-input summary::after\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.interaction-permission-input\[open\] summary::after\s*\{\s*transform:\s*rotate\(/);
  assert.doesNotMatch(css, /interaction-surface\[data-kind="permission"\][^}]*linear-gradient/s);
  assert.doesNotMatch(css, /\.interaction-permission-code\s*\{[^}]*#191919/s);
  assert.doesNotMatch(css, /interaction-permission-actions[^}]*column-reverse/s);
});

test('工具权限文案简洁且升级不会强制覆盖老用户选择', () => {
  const renderer = read('renderer/app.js');
  const main = read('main.js');

  const controls = read('renderer/permission-controls.js');
  assert.match(controls, /label:\s*['"]请求批准['"]/);
  assert.match(controls, /label:\s*['"]帮我批准['"]/);
  assert.match(controls, /label:\s*['"]完全访问权限['"]/);
  assert.match(controls, /自动允许文件编辑，其他操作请求批准/);
  assert.doesNotMatch(renderer, /前台对话工具权限/);
  assert.match(renderer, /surface\.dataset\.kind === ['"]permission['"][\s\S]{0,100}interaction-title/);
  assert.doesNotMatch(
    renderer.slice(renderer.indexOf("window.addEventListener('relay:focus-interaction'")),
    /button:not\(\[disabled\]\)/,
  );
  assert.doesNotMatch(renderer, /逐项确认（决策卡）|全部放行（高风险）/);
  assert.match(main, /normalizeAppPermissionMode\(settings\.permissionMode, \{ hasExistingSettings \}\)/);
  assert.match(main, /background[\s\S]{0,80}resolveUnattendedPermissionMode\(permissionMode\)/);
  assert.match(main, /permissionMode: permissions\.permissionMode/);
  assert.doesNotMatch(main, /applyPermissionModeToLiveSessions|permissionMode\s*\|\|\s*configuredPermissionMode/);
  assert.doesNotMatch(main, /background\s*\?\s*['"]dontAsk['"]/);
  assert.doesNotMatch(main, /settings\.permissionMode\s*===\s*['"]bypassPermissions['"][\s\S]{0,120}settings\.permissionMode\s*=\s*['"]default['"]/);
});

test('独立任务中心已移除，审批和后台任务恢复继续保留', () => {
  assert.equal(fs.existsSync(path.join(root, 'renderer/task-center.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'renderer/task-center.css')), false);
  assert.doesNotMatch(read('renderer/index.html'), /task-center|taskCenterMount|workspaceTasks/);
  assert.match(read('renderer/app.js'), /void restoreActiveRunsFromLedger\(\);/);
  assert.match(read('preload.js'), /tasks:snapshot/);
  const interaction = read('renderer/interaction-surface.js');
  const interactionCss = read('renderer/interaction-surface.css');
  const html = read('renderer/index.html');
  const preload = read('preload.js');
  const main = read('main.js');
  const pkg = read('package.json');


  assert.match(interaction, /interaction-permission-preview/);
  assert.match(interaction, /interaction-action-group/);
  assert.doesNotMatch(interaction, /inputBlock\.open\s*=\s*true/);
  assert.match(interactionCss, /Permission decisions live with the composer/);

  assert.match(main, /if \(!checkpoint \|\| !checkpoint\.available\)/);
  assert.doesNotMatch(html, /id=["']btnWorkspace["']|workspaceCenterMount|workspace-center/);
  assert.doesNotMatch(preload, /workspace:workflows|workspace:projects/);
  assert.doesNotMatch(main, /\bWorkspaceService\b|workspace:workflows|pendingWorkflowDispatches/);
  assert.doesNotMatch(pkg, /workspace-service\.js/);
  assert.equal(fs.existsSync(path.join(root, 'renderer', 'workspace-center.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'renderer', 'workspace-center.css')), false);
  assert.equal(fs.existsSync(path.join(root, 'workspace-service.js')), false);
});
