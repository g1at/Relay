'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createBrowserDiagnostics } = require('./browser-automation-diagnostics');
const { createBrowserEventTracker } = require('./browser-automation-events');

function failure(code, message) { return Object.assign(new Error(message), { code }); }

const { pageOperation } = require('./browser-page-operations');
const playwrightSource = require('./vendor/playwright-injected');
const { namedKeys: keys, modifiers, parseKey, frameOwnerPoint } = require('./browser-input-contract');

function createBrowserAutomationAdapter({ webContents, commandTimeoutMs = 10000 } = {}) {
  if (!webContents?.debugger) throw new TypeError('需要支持调试协议的浏览器标签页。');
  let disposed = false, attached = false, initialized = false, generation = 0, world = null, current = null, busy = false, activeAction = null, mainFrameId = null, pendingChooser = null;
  let focusEmulated = false;
  const worlds = new Map(), frameRecords = new Map(), childSessions = new Map(), frameParents = new Map();
  const debuggerApi = webContents.debugger;
  const lifetime = new AbortController();
  const resolvedLocator = Symbol('current-action-locator');
  const diagnostics = createBrowserDiagnostics();
  const events = createBrowserEventTracker({ webContents });
  const invalidate = () => { generation++; world = null; current = null; worlds.clear(); };
  const onNavigation = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame !== false) invalidate(); };
  const onMessage = (_event, method, params = {}, sessionId) => {
    diagnostics.handleMessage(method, params);
    events.handleMessage(method, params, sessionId);
    if (method === 'Page.fileChooserOpened' && pendingChooser?.armed && pendingChooser.frameId === params.frameId && (pendingChooser.sessionId || null) === (sessionId || null)) pendingChooser.resolve(params);
    if (method === 'Page.frameAttached' && params.parentFrameId) frameParents.set(params.frameId, params.parentFrameId);
    if (method === 'Page.frameNavigated' && params.frame?.parentId) frameParents.set(params.frame.id, params.frame.parentId);
    if (method === 'Page.frameDetached' && params.reason !== 'swap') frameParents.delete(params.frameId);
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') childSessions.set(params.sessionId, params.targetInfo.targetId);
    if (method === 'Target.detachedFromTarget') { childSessions.delete(params.sessionId); invalidate(); }
    if (method === 'Runtime.executionContextsCleared' || method === 'Page.frameNavigated' || method === 'Page.frameDetached') invalidate();
  };
  const onDetach = () => { events.reset(); attached = false; initialized = false; focusEmulated = false; childSessions.clear(); frameRecords.clear(); frameParents.clear(); mainFrameId = null; invalidate(); };
  webContents.on('did-start-navigation', onNavigation);
  webContents.on('destroyed', invalidate);
  debuggerApi.on('message', onMessage);
  debuggerApi.on('detach', onDetach);

  async function guard(options = {}) {
    if (disposed || webContents.isDestroyed()) throw failure('BROWSER_TARGET_CLOSED', '浏览器标签页已关闭或控制连接已释放。');
    if (options.signal?.aborted) throw failure('BROWSER_CANCELLED', '浏览器操作已取消。');
    if (options.check) await options.check();
    if (options.signal?.aborted) throw failure('BROWSER_CANCELLED', '浏览器操作已取消。');
    if (disposed || webContents.isDestroyed()) throw failure('BROWSER_TARGET_CLOSED', '浏览器标签页已关闭或控制连接已释放。');
    if (options.deadline !== undefined && Date.now() >= options.deadline) throw failure('BROWSER_COMMAND_TIMEOUT', '浏览器操作已达到统一时限。');
  }
  function actionOptions(input, options) {
    const timeoutMs = input.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw failure('BROWSER_INVALID_TIMEOUT', '动作等待时限必须在 0 到 30000 毫秒以内');
    return { ...options, deadline: Math.min(options.deadline ?? Infinity, Date.now() + timeoutMs) };
  }
  async function command(method, params, options, beforeDispatch) {
    await guard(options);
    let releaseInput, timer, abort;
    try {
      if (method.startsWith('Input.')) releaseInput = await options?.onInput?.({ method, params });
      await guard(options);
      if (method.startsWith('Input.') && options?.beforeInput) { await options.beforeInput(); await guard(options); }
      if (beforeDispatch) beforeDispatch();
      if (activeAction && (method.startsWith('Input.') || method === 'DOM.setFileInputFiles' || (method === 'Runtime.evaluate' && /"operation":"(?:focus|select|scroll-into-view)"/.test(params.expression)))) activeAction.inputDispatched = true;
      const pending = debuggerApi.sendCommand(method, params, options?.sessionId);
      return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('BROWSER_COMMAND_TIMEOUT', '浏览器命令执行超时。')), Math.max(1, Math.min(commandTimeoutMs, options?.deadline === undefined ? commandTimeoutMs : options.deadline - Date.now())));
        abort = () => reject(failure(disposed ? 'BROWSER_TARGET_CLOSED' : 'BROWSER_CANCELLED', '浏览器操作已取消。'));
        options?.signal?.addEventListener('abort', abort, { once: true });
        lifetime.signal.addEventListener('abort', abort, { once: true });
        if (options?.signal?.aborted || lifetime.signal.aborted) abort();
      })]);
    } finally {
      clearTimeout(timer);
      if (abort) { options?.signal?.removeEventListener('abort', abort); lifetime.signal.removeEventListener('abort', abort); }
      if (typeof releaseInput === 'function') await releaseInput();
    }
  }
  async function delay(milliseconds, options) {
    await guard(options);
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); options?.signal?.removeEventListener('abort', abort); lifetime.signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(failure(disposed ? 'BROWSER_TARGET_CLOSED' : 'BROWSER_CANCELLED', '浏览器操作已取消。')); };
      timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, Math.min(milliseconds, (options?.deadline ?? Infinity) - Date.now())));
      options?.signal?.addEventListener('abort', abort, { once: true }); lifetime.signal.addEventListener('abort', abort, { once: true });
      if (options?.signal?.aborted || lifetime.signal.aborted) abort();
    });
    await guard(options);
  }
  async function waitForBackgroundReady(options) {
    if (typeof options.waitForBackgroundReady !== 'function') return;
    await guard(options);
    let timer, abort;
    try {
      await Promise.race([options.waitForBackgroundReady(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('BROWSER_COMMAND_TIMEOUT', '后台网页初始化等待已达到操作时限。')),
          Math.max(1, Math.min(commandTimeoutMs, (options.deadline ?? Infinity) - Date.now())));
        abort = () => reject(failure(disposed ? 'BROWSER_TARGET_CLOSED' : 'BROWSER_CANCELLED', '浏览器操作已取消。'));
        options.signal?.addEventListener('abort', abort, { once: true });
        lifetime.signal.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted || lifetime.signal.aborted) abort();
      })]);
    } finally {
      clearTimeout(timer);
      if (abort) { options.signal?.removeEventListener('abort', abort); lifetime.signal.removeEventListener('abort', abort); }
    }
    await guard(options);
  }
  async function refreshFrames(options) {
    const next = new Map();
    const collect = (tree, sessionId, parentId) => {
      if (!tree?.frame?.id) return;
      const frame = tree.frame, prior = next.get(frame.id);
      next.set(frame.id, { id: frame.id, parentId: frame.parentId || parentId || prior?.parentId || frameParents.get(frame.id) || null, url: frame.url || '', name: frame.name || '', sessionId,
        main: !sessionId && !parentId && !frame.parentId, supported: worlds.has(frame.id) ? true : 'unknown' });
      for (const child of tree.childFrames || []) collect(child, sessionId, frame.id);
    };
    const root = await command('Page.getFrameTree', {}, options); collect(root.frameTree, undefined, null);
    mainFrameId = root.frameTree?.frame?.id;
    if (mainFrameId) events.setMainFrame({ frameId: mainFrameId, loaderId: root.frameTree.frame.loaderId, url: root.frameTree.frame.url || webContents.getURL() });
    for (const [sessionId] of childSessions) {
      try {
        const nested = { ...options, sessionId };
        await command('Page.enable', {}, nested); await command('Runtime.enable', {}, nested);
        await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, nested);
        const child = await command('Page.getFrameTree', {}, nested); collect(child.frameTree, sessionId, next.get(child.frameTree?.frame?.id)?.parentId);
      } catch (error) { if (['BROWSER_CANCELLED', 'BROWSER_TARGET_CLOSED'].includes(error.code)) throw error; }
    }
    frameRecords.clear(); for (const [id, value] of next) frameRecords.set(id, value);
    return [...frameRecords.values()].map(({ sessionId: _session, ...frame }) => frame);
  }
  async function ensureWorld(options, frameId) {
    await guard(options);
    if (!webContents.getURL()) throw failure('BROWSER_DOCUMENT_NOT_READY', '浏览器页面正在初始化，请等待导航完成。');
    if (!attached) {
      if (debuggerApi.isAttached()) throw failure('BROWSER_DEBUGGER_BUSY', '该标签页已连接其他调试器，请先关闭开发者工具。');
      debuggerApi.attach('1.3'); attached = true;
    }
    if (!initialized) {
      await command('Page.enable', {}, options); await command('Runtime.enable', {}, options); await command('Network.enable', {}, options);
      await command('Page.setLifecycleEventsEnabled', { enabled: true }, options);
      await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, options);
      initialized = true;
    }
    if (!focusEmulated && (typeof options.isBackground === 'function' || options.background === true)) {
      // Emulate document focus/activation on this debugger target only. Unlike
      // WebContents.focus/Page.bringToFront this cannot take OS or Relay focus.
      // Chromium tears down the override with the debugger session on detach.
      await command('Emulation.setFocusEmulationEnabled', { enabled: true }, options);
      focusEmulated = true;
    }
    await waitForBackgroundReady(options);
    if (!mainFrameId || !frameRecords.has(frameId || mainFrameId)) await refreshFrames(options);
    const targetId = frameId || mainFrameId;
    if (!targetId || !frameRecords.has(targetId)) throw failure('BROWSER_FRAME_UNAVAILABLE', '找不到当前框架，请重新读取 frames');
    world = worlds.get(targetId);
    if (!world) {
      if (frameId && childSessions.size) await refreshFrames(options);
      const start = generation;
      const sessionId = frameRecords.get(targetId).sessionId, scoped = { ...options, sessionId };
      let executionContextId;
      try { ({ executionContextId } = await command('Page.createIsolatedWorld', { frameId: targetId, worldName: 'Relay Browser Automation' }, scoped)); }
      catch (error) { if (error.code) throw error; throw failure('BROWSER_FRAME_UNAVAILABLE', '此框架暂时无法建立隔离上下文，请重新读取 frames'); }
      if (start !== generation) throw failure('BROWSER_OBSERVATION_STALE', '观察过程中页面发生导航，请重新观察。');
      const installed = await command('Runtime.evaluate', { contextId: executionContextId, returnByValue: true,
        expression: '/* {"operation":"initialize"} */ (()=>{const module={exports:{}};' + playwrightSource + ';globalThis.__relayPlaywright=new (module.exports.InjectedScript())(globalThis,{isUnderTest:false,sdkLanguage:"javascript",testIdAttributeName:"data-testid",stableRafCount:2,browserName:"chromium",customEngines:[],isUtilityWorld:true});return true;})()' }, scoped);
      if (installed.exceptionDetails) throw failure('BROWSER_ENGINE_INITIALIZATION_FAILED', '浏览器语义引擎初始化失败');
      if (start !== generation) throw failure('BROWSER_OBSERVATION_STALE', '初始化期间框架已变化');
      world = { executionContextId, generation: start, frameId: targetId, sessionId };
      worlds.set(targetId, world);
    }
    return world;
  }
  async function evaluate(request, options, returnByValue = true) {
    const context = await ensureWorld(options, request.frameId === null ? undefined : request.frameId || current?.frameId);
    let result;
    try { result = await command('Runtime.evaluate', { expression: '(' + pageOperation.toString() + ')(' + JSON.stringify(request) + ')', contextId: context.executionContextId, returnByValue, awaitPromise: request.operation === 'prepare-stable' }, { ...options, sessionId: context.sessionId },
      request.operation === 'select' ? () => assertObservation(request) : undefined); }
    catch (error) { if (context.generation !== generation) throw failure('BROWSER_OBSERVATION_STALE', '操作过程中页面已变化，请重新观察。'); throw error; }
    await guard(options);
    if (context.generation !== generation) throw failure('BROWSER_OBSERVATION_STALE', '操作过程中页面已变化，请重新观察。');
    if (result.exceptionDetails) throw failure('BROWSER_PAGE_EVALUATION_FAILED', '浏览器无法读取当前文档。');
    if (!returnByValue) {
      if (result.result?.subtype !== 'node' || !result.result.objectId) throw failure('BROWSER_FILE_INPUT_REQUIRED', '文件输入框已变化，请重新观察。');
      return { objectId: result.result.objectId };
    }
    const value = result.result?.value;
    if (value?.error) throw failure(value.error.code, value.error.message);
    if (value === undefined) throw failure('BROWSER_PAGE_EVALUATION_FAILED', '浏览器未返回文档数据。');
    return value;
  }
  async function exclusive(run) {
    if (busy) throw failure('BROWSER_OPERATION_BUSY', '该标签页正在执行另一项操作。');
    busy = true;
    try { return await run(); } finally { busy = false; }
  }
  async function observeInternal(options, query = {}) {
    const observationId = randomUUID();
    const frameId = query.frameId || mainFrameId || null;
    const result = await evaluate({ ...query, operation: query.operation || 'observe', observationId, frameId }, options);
    current = { observationId, generation, url: webContents.getURL(), frameId: frameId || mainFrameId };
    return { ...result, frameId: current.frameId };
  }
  function assertObservation(input) {
    if (!input?.observationId || !current || current.observationId !== input.observationId || current.generation !== generation || current.url !== webContents.getURL())
      throw failure('BROWSER_OBSERVATION_STALE', '需要当前页面的观察编号，请重新观察标签页。');
    if (input.frameId && input.frameId !== current.frameId) throw failure('BROWSER_OBSERVATION_STALE', '观察编号属于另一个框架');
  }
  async function preflight(input, options, operation = 'prepare') {
    await guard(options); assertObservation(input);
    try { return await evaluate({ operation, observationId: input.observationId, ref: input.ref, kind: input.kind, x: input.x, y: input.y }, options); }
    catch (error) {
      if (error.code === 'BROWSER_ELEMENT_STALE' && input[resolvedLocator]) error[resolvedLocator] = true;
      throw error;
    }
  }
  async function resolveInput(input, options) {
    assertObservation(input);
    if (input.locator && !input.ref) {
      const timeout = input.timeoutMs ?? 5000;
      if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30000) throw failure('BROWSER_INVALID_WAIT', '操作等待时限须为 0 到 30000 毫秒');
      const end = Math.min(Date.now() + timeout, options.deadline ?? Infinity);
      while (true) {
        await guard(options); assertObservation(input);
        try {
          const matched = await evaluate({ operation: 'resolve-locator', observationId: input.observationId, locator: input.locator }, options);
          return { ...input, ref: matched.ref, [resolvedLocator]: true };
        } catch (error) {
          if (error.code !== 'BROWSER_LOCATOR_NOT_FOUND' || Date.now() >= end) throw error;
          try { await delay(Math.min(50, end - Date.now()), options); }
          catch (waitError) { if (waitError.code === 'BROWSER_COMMAND_TIMEOUT') throw error; throw waitError; }
        }
      }
    }
    return input;
  }
  async function actionable(input, options) {
    if (!input.ref) {
      if (input.kind !== 'scroll' && (!Number.isFinite(input.x) || !Number.isFinite(input.y))) throw failure('BROWSER_INVALID_POINT', '坐标动作需要 x 和 y');
      return evaluate({ operation: 'point', observationId: input.observationId, x: input.x ?? 1, y: input.y ?? 1 }, options);
    }
    const timeout = input.timeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30000) throw failure('BROWSER_INVALID_WAIT', '操作等待时限须为 0 到 30000 毫秒');
    const end = Math.min(Date.now() + timeout, options.deadline ?? Infinity);
    let lastActionabilityError;
    while (true) {
      try { const point = await preflight(input, options, 'prepare-stable'); await rootPoint(point, { ...options, stableFrames: true }); return point; }
      catch (error) {
        if (error.code === 'BROWSER_COMMAND_TIMEOUT' && lastActionabilityError) throw lastActionabilityError;
        if (error.code === 'BROWSER_ELEMENT_OFFSCREEN') { await evaluate({ operation: 'scroll-into-view', observationId: input.observationId, ref: input.ref }, options); }
        else if (!['BROWSER_ELEMENT_HIDDEN', 'BROWSER_ELEMENT_DISABLED', 'BROWSER_ELEMENT_OBSCURED', 'BROWSER_ELEMENT_UNSTABLE', 'BROWSER_FRAME_OBSCURED', 'BROWSER_FRAME_UNSTABLE'].includes(error.code)) throw error;
        lastActionabilityError = error;
        if (Date.now() >= end) throw error;
        try { await delay(Math.min(50, end - Date.now()), options); }
          catch (waitError) { if (waitError.code === 'BROWSER_COMMAND_TIMEOUT') throw error; throw waitError; }
      }
    }
  }
  async function rootPoint(point, options) {
    let frameId = current?.frameId, mapped = point;
    const visited = new Set();
    while (frameId && frameId !== mainFrameId) {
      if (visited.has(frameId)) throw failure('BROWSER_FRAME_UNAVAILABLE', '框架树无效');
      visited.add(frameId);
      const frame = frameRecords.get(frameId);
      if (!frame?.parentId) throw failure('BROWSER_FRAME_UNAVAILABLE', '框架父级暂不可用，请重新读取 frames');
      const viewport = await evaluate({ operation: 'viewport', frameId }, options);
      const parent = await ensureWorld(options, frame.parentId), scoped = { ...options, sessionId: parent.sessionId };
      const { backendNodeId } = await command('DOM.getFrameOwner', { frameId }, scoped);
      const resolved = await command('DOM.resolveNode', { backendNodeId, executionContextId: parent.executionContextId }, scoped);
      const objectId = resolved.object?.objectId;
      if (!objectId) throw failure('BROWSER_FRAME_UNAVAILABLE', '框架容器已变化');
      try {
        const functionDeclaration = options.stableFrames ? 'async function(point,viewport){const state=await globalThis.__relayPlaywright.checkElementStates(this,["visible","stable"]);if(state)return {error:{code:state.missingState==="stable"?"BROWSER_FRAME_UNSTABLE":"BROWSER_FRAME_UNAVAILABLE",message:"框架几何尚未稳定或已卸载"}};return (' + frameOwnerPoint.toString() + ').call(this,point,viewport);}' : frameOwnerPoint.toString();
        const result = await command('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: [{ value: mapped }, { value: viewport }], returnByValue: true, awaitPromise: !!options.stableFrames }, scoped);
        if (result.exceptionDetails || !result.result?.value) throw failure('BROWSER_FRAME_UNAVAILABLE', '无法读取框架容器');
        mapped = result.result.value;
        if (mapped.error) throw failure(mapped.error.code, mapped.error.message);
      } finally { try { await command('Runtime.releaseObject', { objectId }, { sessionId: parent.sessionId, deadline: Date.now() + 250 }); } catch (_) {} }
      frameId = frame.parentId;
    }
    return mapped;
  }
  async function assertRootPoint(point, expected, options) {
    const actual = await rootPoint(point, options);
    if (actual.x !== expected.x || actual.y !== expected.y) throw failure('BROWSER_ELEMENT_UNSTABLE', '输入握手期间框架位置已变化，本次未发送输入。');
  }
  async function inputCommand(method, params, input, options, focused = false) {
    const pointer = ['Input.dispatchMouseEvent', 'Input.synthesizeTapGesture'].includes(method), point = { x: params.x, y: params.y };
    await preflight(pointer && input.ref ? { ...input, x: params.x, y: params.y } : input, options, focused ? 'focused' : input.ref ? 'prepare' : 'assert-document');
    if (pointer) params = { ...params, ...await rootPoint({ x: params.x, y: params.y }, options) };
    else if (input.ref) await rootPoint(await preflight(input, options), options);
    await guard(options); assertObservation(input);
    return command(method, params, { ...options, beforeInput: async () => {
      // The trusted input handshake may yield to a rerender. Revalidate the
      // retained node and the same dispatch coordinates after it acknowledges.
      await preflight(input.ref ? { ...input, ...(pointer ? { x: point.x, y: point.y } : {}) } : input, options, focused ? 'focused' : input.ref ? 'prepare' : 'assert-document');
      if (pointer) await assertRootPoint(point, params, options);
    } }, () => {
      assertObservation(input);
      if (params.type === 'mouseWheel' && options.wheelZoom !== undefined
        && (webContents.getZoomFactor?.() || 1) !== options.wheelZoom) throw failure('BROWSER_ELEMENT_UNSTABLE', '输入握手期间网页缩放已变化，本次未发送滚动。');
      if ((method === 'Input.synthesizeTapGesture' || params.type === 'mousePressed') && options.beforeClick) options.beforeClick();
    });
  }
  async function clickInput(input, options, count = 1) {
    let point = await actionable(input, options);
    await inputCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, input, options);
    point = await actionable(input, options);
    const mask = modifiers(input.modifiers || []), button = input.button || 'left';
    if (!['left', 'right', 'middle'].includes(button)) throw failure('BROWSER_INVALID_BUTTON', '鼠标按键无效');
    // Task-backed callers can hide the view during any awaited handshake. Use
    // the same targeted CDP pair in both states so a visibility transition
    // cannot strand a gesture that was selected while the page was presented.
    const backgroundCapable = typeof options.isBackground === 'function' || options.background === true;
    if (button === 'left' && !mask && count === 1 && !backgroundCapable) return inputCommand('Input.synthesizeTapGesture', { ...point, duration: 50, tapCount: count, gestureSourceType: 'mouse' }, input, options);
    const root = await rootPoint(point, options);
    await guard(options); assertObservation(input);
    // Both halves are queued together, so navigation on down cannot leave a held button.
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      const pressed = { type: 'mousePressed', ...root, button, clickCount, modifiers: mask };
      // Complete the pointer handshake before queuing the pair. Otherwise mouse-up's
      // no-op handshake could overtake the awaited pointer-down acknowledgement.
      const releaseInput = await options.onInput?.({ method: 'Input.dispatchMouseEvent', params: pressed });
      try {
        await guard(options); assertObservation(input);
        await preflight(input.ref ? { ...input, ...point } : input, options, input.ref ? 'prepare' : 'assert-document');
        await assertRootPoint(point, root, options);
        const queued = { ...options, onInput: undefined };
        const results = await Promise.allSettled([
          command('Input.dispatchMouseEvent', pressed, queued, () => { assertObservation(input); options.beforeClick?.(); }),
          command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...root, button, clickCount, modifiers: mask }, queued, () => assertObservation(input)),
        ]);
        const rejected = results.find(result => result.status === 'rejected'); if (rejected) throw rejected.reason;
      } finally { if (typeof releaseInput === 'function') await releaseInput(); }
    }
  }
  async function wheelInput(input, options, point, deltaX, deltaY) {
    if (typeof webContents.sendInputEvent !== 'function' || typeof options.isBackground === 'function' || options.background === true) {
      const zoom = webContents.getZoomFactor?.() || 1;
      if (!Number.isFinite(zoom) || zoom <= 0 || zoom > 5) throw failure('BROWSER_INVALID_ZOOM', '网页缩放比例无效');
      // Chromium keeps CDP pointer coordinates in CSS pixels but converts wheel
      // deltas through page zoom before exposing a DOM WheelEvent.
      await inputCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: deltaX * zoom, deltaY: deltaY * zoom }, input, { ...options, wheelZoom: zoom });
      return 'cdp-wheel';
    }
    const mapped = await rootPoint(point, options);
    const zoom = typeof webContents.getZoomFactor === 'function' ? webContents.getZoomFactor() : 1;
    if (!Number.isFinite(zoom) || zoom <= 0 || zoom > 5) throw failure('BROWSER_INVALID_ZOOM', '网页缩放比例无效');
    const event = { type: 'mouseWheel', x: Math.round(mapped.x * zoom), y: Math.round(mapped.y * zoom), deltaX: -deltaX * zoom, deltaY: -deltaY * zoom, canScroll: true };
    const releaseInput = await options.onInput?.({ method: 'webContents.sendInputEvent', params: event });
    try {
      await guard(options); assertObservation(input);
      await preflight(input.ref ? { ...input, ...point } : input, options, input.ref ? 'prepare' : 'assert-document');
      await assertRootPoint(point, mapped, options);
      if ((typeof webContents.getZoomFactor === 'function' ? webContents.getZoomFactor() : 1) !== zoom) throw failure('BROWSER_ELEMENT_UNSTABLE', '输入握手期间网页缩放已变化，本次未发送滚动。');
      await guard(options); assertObservation(input);
      activeAction.inputDispatched = true;
      webContents.sendInputEvent(event);
      await delay(40, options);
      return 'electron-wheel';
    } finally { if (typeof releaseInput === 'function') await releaseInput(); }
  }
  async function keyStroke(key, input, options) {
    await preflight(input, options, input.ref ? 'focused' : 'assert-document');
    if (input.ref) await rootPoint(await preflight(input, options), options);
    const { text: _text, ...release } = key;
    const pressed = { type: 'keyDown', ...key };
    const releaseInput = await options.onInput?.({ method: 'Input.dispatchKeyEvent', params: pressed });
    // Queue both halves before yielding to Chromium input/navigation events.
    // A native keystroke must finish its release even if keyDown navigates.
    // Each command still checks cancellation, ownership and document identity
    // immediately before it is queued. No subsequent gesture reuses old refs.
    try {
      await guard(options); assertObservation(input);
      await preflight(input, options, input.ref ? 'focused' : 'assert-document');
      if (input.ref) await rootPoint(await preflight(input, options), options);
      // The pair shares one visibility handshake, then enters the CDP queue
      // together. Separate async handshakes could reject keyUp as input-busy.
      const queued = { ...options, onInput: undefined };
      const results = await Promise.allSettled([
        command('Input.dispatchKeyEvent', pressed, queued, () => assertObservation(input)),
        command('Input.dispatchKeyEvent', { type: 'keyUp', ...release }, queued, () => assertObservation(input)),
      ]);
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    } finally { if (typeof releaseInput === 'function') await releaseInput(); }
  }
  function validateAssertions(input) {
    if (input.ref && input.state === 'detached') throw failure('BROWSER_INVALID_ASSERTION', '等待元素卸载需要 locator；失效引用不能用于卸载断言。');
    if (input.ref && input.locator) throw failure('BROWSER_INVALID_ASSERTION', '元素引用和定位条件只能指定一种。');
    if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim())) throw failure('BROWSER_VERIFICATION_REQUIRED', '待核验的页面文本不能为空。');
    if (input.url !== undefined && (typeof input.url !== 'string' || !input.url)) throw failure('BROWSER_INVALID_ASSERTION', '待核验网址必须为非空文本。');
    if (input.count !== undefined && (!input.locator || !Number.isInteger(input.count) || input.count < 0 || input.count > 100000)) throw failure('BROWSER_INVALID_ASSERTION', '数量断言需要定位条件和 0 到 100000 的整数。');
    for (const key of ['checked', 'enabled', 'editable', 'selected']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw failure('BROWSER_INVALID_ASSERTION', '元素状态断言必须为布尔值。');
    if (input.attribute !== undefined && (!input.attribute || typeof input.attribute !== 'object' || Array.isArray(input.attribute) || Object.keys(input.attribute).some(key => !['name', 'value'].includes(key)) || typeof input.attribute.name !== 'string' || !/^[^\s"'<>/=\u0000-\u001f\u007f]{1,200}$/.test(input.attribute.name) || !(input.attribute.value === null || typeof input.attribute.value === 'string' && input.attribute.value.length <= 20000))) throw failure('BROWSER_INVALID_ASSERTION', '属性断言需要有效名称和文本值，或用 null 表示属性不存在。');
    const elementAssertions = ['value', 'checked', 'enabled', 'editable', 'selected', 'attribute'];
    if (elementAssertions.some(key => input[key] !== undefined) && !input.ref && !input.locator) throw failure('BROWSER_ELEMENT_REQUIRED', '元素状态核验需要引用或唯一定位条件。');
    if (input.state !== undefined && ((!input.ref && !input.locator) || !['attached', 'detached', 'visible', 'hidden', 'enabled'].includes(input.state))) throw failure('BROWSER_INVALID_WAIT', '元素等待状态无效。');
    if (!input.locator && !['text', 'url', 'state', ...elementAssertions].some(key => input[key] !== undefined)) throw failure('BROWSER_VERIFICATION_REQUIRED', '请提供文本、网址或元素状态作为核验条件。');
  }
  async function readAssertions(input, options) {
    await guard(options);
    if (input.observationId || input.ref) assertObservation(input);
    const frameId = input.frameId || (input.ref ? current?.frameId : null), checks = [];
    let state;
    if (input.locator) {
      const explicit = ['count', 'text', 'value', 'checked', 'enabled', 'editable', 'selected', 'attribute'].some(key => input[key] !== undefined);
      state = await evaluate({ operation: 'query-state', frameId, locator: input.locator, wantUnique: input.state !== undefined || !explicit, wantValue: input.value !== undefined, wantText: input.text !== undefined,
        wantChecked: input.checked !== undefined, wantEnabled: input.enabled !== undefined, wantEditable: input.editable !== undefined, wantSelected: input.selected !== undefined, attributeName: input.attribute?.name }, options);
      if (input.count !== undefined) checks.push({ kind: 'count', passed: state.count === input.count, actual: state.count, expected: input.count });
      if (input.state !== undefined || !explicit) {
        const requested = input.state || 'visible';
        checks.push({ kind: requested, passed: requested === 'detached' ? !state.attached : requested === 'hidden' ? !state.visible : !!state[requested], count: state.count });
      }
    } else if (input.ref) {
      state = await evaluate({ operation: 'verify-element', frameId, observationId: input.observationId, ref: input.ref, value: input.value, attributeName: input.attribute?.name }, options);
      if (input.state !== undefined) checks.push({ kind: input.state, passed: input.state === 'detached' ? !state.attached : input.state === 'hidden' ? !state.visible : !!state[input.state] });
    }
    if (state) {
      const unique = !input.locator || state.count === 1;
      if (input.value !== undefined) checks.push({ kind: 'value', passed: unique && state.value === String(input.value) });
      if (input.text !== undefined) checks.push({ kind: 'text', passed: unique && String(state.text || '').includes(input.text) });
      for (const key of ['checked', 'enabled', 'editable', 'selected']) if (input[key] !== undefined) checks.push({ kind: key, passed: unique && state[key] === input[key], actual: state[key] ?? null, expected: input[key] });
      if (input.attribute !== undefined) checks.push({ kind: 'attribute', name: input.attribute.name, passed: unique && state.attribute === input.attribute.value });
    }
    if ((!input.ref && !input.locator && input.text !== undefined) || input.url !== undefined) {
      const page = await evaluate({ operation: 'read-page', frameId }, options);
      if (!input.ref && !input.locator && input.text !== undefined) checks.push({ kind: 'text', passed: page.text.includes(input.text) });
      if (input.url !== undefined) checks.push({ kind: 'url', passed: page.url === input.url });
    }
    return checks;
  }
  function assertionObservation() {
    // Reading assertions must not rotate reference IDs. Callers can explicitly
    // observe if navigation invalidated the last retained observation.
    return { observation: null, requiresObservation: !current || current.generation !== generation || current.url !== webContents.getURL() };
  }
  async function prepareAwait(input, options = {}, waitOptions = options) {
    await ensureWorld(options, mainFrameId || undefined);
    const frameTree = await command('Page.getFrameTree', {}, options), frame = frameTree.frameTree?.frame;
    if (frame?.id) {
      const page = await evaluate({ operation: 'read-page', frameId: frame.id }, options);
      events.setMainFrame({ frameId: frame.id, loaderId: frame.loaderId, url: page.url, readyState: page.readyState });
    }
    await guard(options);
    const pending = events.prepare(input, waitOptions);
    // Registration precedes input; early cancellation must remain handled until
    // the action reaches the result await below. The original promise still rejects.
    pending.result.catch(() => {});
    return pending;
  }
  return {
    prepareAwait,
    observe: (options = {}, query = {}) => exclusive(() => observeInternal(options, query)),
    locate: (input = {}, options = {}) => exclusive(() => observeInternal(options, { ...input, operation: 'locate' })),
    frames: (options = {}) => exclusive(async () => {
      await ensureWorld(options); const frames = await refreshFrames(options);
      for (const frame of frames.slice(0, 50)) { try { await ensureWorld({ ...options, deadline: Math.min(options.deadline ?? Infinity, Date.now() + 1000) }, frame.id); frame.supported = true; }
        catch (error) { if (['BROWSER_CANCELLED', 'BROWSER_TARGET_CLOSED'].includes(error.code)) throw error; frame.supported = false; frame.reason = error.code || 'BROWSER_FRAME_UNAVAILABLE'; } }
      return { frames, limitations: ['closed-shadow-roots-unsupported', 'rotated-frame-input-unsupported', ...(frames.length > 50 ? ['frame-probe-limited-to-50'] : [])] };
    }),
    act: (input, options = {}) => exclusive(async () => {
      activeAction = { inputDispatched: false };
      const authority = options; let pendingEvent;
      try {
        options = actionOptions(input, options);
        await guard(options); assertObservation(input);
        if (!['click', 'doubleClick', 'rightClick', 'hover', 'fill', 'press', 'scroll', 'select', 'drag', 'scrollIntoView'].includes(input.kind)) throw failure('BROWSER_ACTION_UNSUPPORTED', '浏览器动作不受支持');
        if (input.waitFor) pendingEvent = await prepareAwait(input.waitFor, options, authority);
        const originalInput = input;
        let actionDetail = {}, frameId = current.frameId;
        for (;;) {
          try {
            input = await resolveInput(originalInput, options);
            if (!input.ref && !['click', 'doubleClick', 'rightClick', 'hover', 'drag', 'scroll', 'press'].includes(input.kind)) throw failure('BROWSER_ELEMENT_REQUIRED', '此动作需要元素引用或唯一定位条件');
            if (input.ref && !/^e\d+$/.test(input.ref)) throw failure('BROWSER_ELEMENT_REQUIRED', '元素引用无效');
            if (input.kind === 'fill' && (typeof input.text !== 'string' || input.text.length > 10000)) throw failure('BROWSER_INVALID_TEXT', '填写内容必须为不超过 10000 字符的文本');
            if (['click', 'doubleClick', 'rightClick'].includes(input.kind)) {
              await clickInput(input.kind === 'rightClick' ? { ...input, button: 'right' } : input, options, input.kind === 'doubleClick' ? 2 : 1);
            } else if (input.kind === 'hover') {
              await inputCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await actionable(input, options) }, input, options);
            } else if (input.kind === 'fill' || input.kind === 'press') {
              if (input.ref) { await actionable(input, options); await preflight(input, options, 'focus'); }
              if (input.kind === 'fill') {
                await keyStroke(parseKey('ControlOrMeta+a'), input, options);
                if (input.text) await inputCommand('Input.insertText', { text: input.text }, input, options, true);
                else await keyStroke(keys.Backspace, input, options);
              } else await keyStroke(parseKey(input.key), input, options);
            } else if (input.kind === 'select') {
              const values = input.values === undefined && typeof input.value === 'string' ? [input.value] : input.values;
              if (!Array.isArray(values) || values.length < 1 || values.length > 100 || values.some(value => typeof value !== 'string' || value.length > 2000) || new Set(values).size !== values.length) throw failure('BROWSER_INVALID_SELECTION', '选项值必须是 1 到 100 项且不重复的文本列表');
              await actionable(input, options);
              actionDetail = await evaluate({ operation: 'select', observationId: input.observationId, ref: input.ref, values }, options);
            } else if (input.kind === 'scrollIntoView') {
              actionDetail = await evaluate({ operation: 'scroll-into-view', observationId: input.observationId, ref: input.ref }, options);
              await actionable(input, options);
            } else if (input.kind === 'drag') {
              const from = await actionable(input, options);
              let target = { ...input, [resolvedLocator]: false, ref: input.toRef, locator: input.toLocator, x: input.to?.x, y: input.to?.y };
              target = await resolveInput(target, options);
              const to = await actionable(target, options), start = await rootPoint(from, options), end = await rootPoint(to, options);
              let pressed = false;
              const dragOptions = { ...options, beforeInput: async () => {
                // After down, the original source may move with the pointer.
                // Retain its identity, validate the original frame mapping and
                // keep the drop endpoint fixed; never relocate either node.
                await preflight({ ...input, ...from }, options, input.ref ? pressed ? 'verify-element' : 'prepare' : 'assert-document');
                await preflight({ ...target, ...to }, options, target.ref ? 'prepare' : 'assert-document');
                await assertRootPoint(from, start, options);
                await assertRootPoint(to, end, options);
              } };
              await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start }, dragOptions, () => assertObservation(input));
              try {
                await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 }, dragOptions, () => { assertObservation(input); pressed = true; });
                for (let step = 1; step <= 10; step++) await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (end.x - start.x) * step / 10, y: start.y + (end.y - start.y) * step / 10, button: 'left', buttons: 1 }, dragOptions, () => assertObservation(input));
                await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 }, dragOptions, () => assertObservation(input)); pressed = false;
              } finally {
                // A release is cleanup for our already-held button, never a new gesture.
                if (pressed && attached && !disposed && !webContents.isDestroyed()) { try { await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...start, button: 'left', buttons: 0, clickCount: 0 }, { deadline: Date.now() + 250, onInput: options.onInput }); } catch (_) {} }
              }
            } else {
              const deltaX = input.deltaX ?? 0, deltaY = input.deltaY ?? 600;
              if (![deltaX, deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 2000)) throw failure('BROWSER_INVALID_SCROLL', '单次滚动距离必须在 -2000 到 2000 之间');
              actionDetail.inputMode = await wheelInput(input, options, await actionable(input, options), deltaX, deltaY);
            }
            break;
          } catch (error) {
            if (error.code !== 'BROWSER_ELEMENT_STALE' || activeAction.inputDispatched || !error[resolvedLocator]) throw error;
            await guard(options); assertObservation(originalInput);
            await delay(25, options);
          }
        }
        let waitResult;
        if (pendingEvent) {
          waitResult = await pendingEvent.result;
          await guard(authority);
          // Event waiting has its own bounded budget. Never replay a completed
          // gesture because the result timed out or the action budget has ended.
          if (Date.now() >= options.deadline) return { executed: true, ...actionDetail, waitResult, observation: null, requiresObservation: true };
        } else await delay(75, options);
        try { return { executed: true, ...actionDetail, ...(pendingEvent ? { waitResult } : {}), observation: await observeInternal(options, { frameId }) }; }
        catch (error) {
          await guard(authority);
          if (['BROWSER_CANCELLED', 'BROWSER_TARGET_CLOSED'].includes(error.code)) throw error;
          if (pendingEvent) return { executed: true, ...actionDetail, waitResult, observation: null, requiresObservation: true, observationError: error.code || 'BROWSER_OBSERVATION_FAILED' };
          throw Object.assign(failure('BROWSER_ACTION_OUTCOME_UNKNOWN', '输入已发送，但尚未确认页面结果。请重新观察后决定是否重试。'), { executed: true, causeCode: error.code || 'BROWSER_OBSERVATION_FAILED' });
        }
      } catch (error) { error.inputDispatched = activeAction.inputDispatched; throw error; }
      finally { pendingEvent?.dispose(); activeAction = null; }
    }),
    verify: (input = {}, options = {}) => exclusive(async () => {
      validateAssertions(input);
      const checks = await readAssertions(input, options), satisfied = checks.length > 0 && checks.every(check => check.passed);
      return { verified: satisfied, satisfied, checks, ...assertionObservation() };
    }),
    wait: (input = {}, options = {}) => exclusive(async () => {
      await guard(options);
      if (input.event !== undefined) {
        if (['ref', 'locator', 'observationId', 'text', 'value', 'state', 'count', 'checked', 'enabled', 'editable', 'selected', 'attribute'].some(key => input[key] !== undefined)) throw failure('BROWSER_INVALID_EVENT_WAIT', '事件等待不能混用元素断言。');
        const pending = await prepareAwait(input, options);
        try { const result = await pending.result; await guard(options); return { ...result, verified: result.satisfied, checks: [{ kind: input.event, passed: result.satisfied }], ...assertionObservation() }; }
        finally { pending.dispose(); }
      }
      const timeoutMs = input.timeoutMs ?? 5000, interval = input.pollIntervalMs ?? 100;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 || !Number.isInteger(interval) || interval < 50 || interval > 1000) throw failure('BROWSER_INVALID_WAIT', '等待时限须为 100 到 30000 毫秒，轮询间隔须为 50 到 1000 毫秒。');
      validateAssertions(input);
      const deadline = Math.min(options.deadline ?? Infinity, Date.now() + timeoutMs), polling = { ...options, deadline };
      let checks = [], satisfied = false;
      while (Date.now() < deadline) {
        try {
          checks = await readAssertions(input, polling);
          satisfied = checks.length > 0 && checks.every(check => check.passed);
          if (satisfied) break;
        } catch (error) {
          if (error.code === 'BROWSER_COMMAND_TIMEOUT' && Date.now() >= deadline) break;
          if (input.ref || input.observationId || !['BROWSER_OBSERVATION_STALE', 'BROWSER_DOCUMENT_NOT_READY'].includes(error.code)) throw error;
          checks = [{ kind: 'document-ready', passed: false }];
        }
        if (Date.now() < deadline) {
          try { await delay(Math.min(interval, deadline - Date.now()), polling); }
          catch (error) { if (error.code !== 'BROWSER_COMMAND_TIMEOUT') throw error; break; }
        }
      }
      await guard(options);
      return { satisfied, verified: satisfied, timedOut: !satisfied, checks, ...assertionObservation() };
    }),
    upload: (input = {}, options = {}) => exclusive(async () => {
      activeAction = { inputDispatched: false };
      let objectId, scoped = options, interception = false;
      try {
        await guard(options); assertObservation(input);
        input = await resolveInput(input, options);
        if (typeof input.ref !== 'string' || !/^e\d+$/.test(input.ref)) throw failure('BROWSER_ELEMENT_REQUIRED', '上传需要元素引用或唯一定位条件');
        if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 16 || input.files.some(file => typeof file !== 'string' || file.length > 4096 || file.includes('\0') || !path.isAbsolute(file)) || new Set(input.files).size !== input.files.length) throw failure('BROWSER_INVALID_UPLOAD_FILES', '上传需要主进程验证后的 1 到 16 个不同绝对文件路径');
        const frameId = current.frameId, context = await ensureWorld(options, frameId);
        scoped = { ...options, sessionId: context.sessionId };
        if (input.chooser) {
          let resolveChooser;
          const chosen = new Promise(resolve => { resolveChooser = resolve; });
          pendingChooser = { frameId, sessionId: context.sessionId, armed: false, resolve: resolveChooser };
          await command('Page.setInterceptFileChooserDialog', { enabled: true }, scoped); interception = true;
          await clickInput({ ...input, kind: 'click' }, { ...options, beforeClick: () => { assertObservation(input); pendingChooser.armed = true; options.beforeClick?.(); } });
          const end = Date.now() + Math.min(input.timeoutMs ?? 5000, 30000);
          let selected;
          chosen.then(value => { selected = value; });
          while (!selected && Date.now() < end) await delay(25, options);
          if (!selected) throw failure('BROWSER_FILE_CHOOSER_TIMEOUT', '点击后未出现属于目标框架的文件选择器');
          assertObservation(input);
          const resolved = await command('DOM.resolveNode', { backendNodeId: selected.backendNodeId, executionContextId: context.executionContextId }, scoped);
          objectId = resolved.object?.objectId;
          if (!objectId) throw failure('BROWSER_FILE_INPUT_REQUIRED', '选择器输入框已变化');
          const checked = await command('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: 'function(count){return this.isConnected && this.tagName === "INPUT" && this.type === "file" && !this.disabled && !this.webkitdirectory && !this.hasAttribute("directory") && (count === 1 || this.multiple)}', arguments: [{ value: input.files.length }] }, scoped);
          if (!checked.result?.value) throw failure('BROWSER_FILE_INPUT_REQUIRED', '选择器不是支持的文件输入框');
        } else {
          const request = { observationId: input.observationId, ref: input.ref, fileCount: input.files.length };
          await evaluate({ ...request, operation: 'file-check' }, options);
          ({ objectId } = await evaluate({ ...request, operation: 'file-node' }, options, false));
          await evaluate({ ...request, operation: 'file-check' }, options);
        }
        await command('DOM.setFileInputFiles', { objectId, files: input.files }, scoped, () => assertObservation(input));
        await delay(75, options);
        try { return { executed: true, fileCount: input.files.length, inputMode: input.chooser ? 'cdp-file-chooser' : 'cdp-file-input', observation: await observeInternal(options, { frameId }) }; }
        catch (error) {
          if (['BROWSER_CANCELLED', 'BROWSER_TARGET_CLOSED'].includes(error.code)) throw error;
          throw Object.assign(failure('BROWSER_ACTION_OUTCOME_UNKNOWN', '文件已交给网页，但尚未确认页面结果。请重新观察后决定是否重试。'), { executed: true, causeCode: error.code });
        }
      } catch (error) { error.inputDispatched = activeAction.inputDispatched; throw error; }
      finally {
        activeAction = null; pendingChooser = null;
        if (attached && !disposed) {
          const cleanup = { sessionId: scoped.sessionId, deadline: Date.now() + 250 };
          if (interception) try { await command('Page.setInterceptFileChooserDialog', { enabled: false }, cleanup); } catch (_) {}
          if (objectId) try { await command('Runtime.releaseObject', { objectId }, cleanup); } catch (_) {}
        }
      }
    }),
    diagnostics: (input = {}, options = {}) => exclusive(async () => {
      await ensureWorld(options); await guard(options);
      return diagnostics.read(input);
    }),
    screenshot: (options = {}, input = {}) => exclusive(async () => {
      await ensureWorld(options);
      const before = generation, url = webContents.getURL();
      let clip = input.clip;
      if (input.fullPage) { const metrics = await command('Page.getLayoutMetrics', {}, options); const size = metrics.cssContentSize || metrics.contentSize; clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height) }; }
      if (clip && (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0 || clip.width > 16384 || clip.height > 16384 || clip.width * clip.height > 32000000)) throw failure('BROWSER_SCREENSHOT_TOO_LARGE', '截图范围必须在 16384 像素边长和 3200 万总像素以内');
      const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!input.fullPage || !!clip, fromSurface: true, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, options);
      await guard(options);
      if (before !== generation || url !== webContents.getURL()) throw failure('BROWSER_OBSERVATION_STALE', '截图过程中页面已变化，请重试。');
      return { data: result.data, mimeType: 'image/png', url };
    }),
    dispose() {
      if (disposed) return; disposed = true; lifetime.abort(); invalidate(); diagnostics.dispose(); events.dispose();
      webContents.removeListener('did-start-navigation', onNavigation); webContents.removeListener('destroyed', invalidate);
      debuggerApi.removeListener('message', onMessage); debuggerApi.removeListener('detach', onDetach);
      if (attached && debuggerApi.isAttached()) { try { debuggerApi.detach(); } catch (_) {} }
      attached = false; focusEmulated = false;
    },
  };
}

module.exports = { createBrowserAutomationAdapter };
