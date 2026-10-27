'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { MediaTaskStore } = require('./media-task-store');

const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const forbiddenHeader = name => /authorization|api[-_]?key|token|secret|cookie/i.test(name);
const snapshotFields = ['routeId', 'bindingId', 'providerId', 'providerName', 'providerRevision', 'mediaRevision', 'credentialRef', 'credentialVersion', 'credentialSource', 'version', 'protocol', 'modelId', 'baseUrl', 'auth', 'routeHeaders', 'endpoints', 'capabilities', 'errorProfile', 'editTransport', 'modality'];
const controlFields = new Set(['model', 'selection', 'conversationId', 'turnIndex', 'runId', 'taskId', 'source', 'signal', 'expectedMediaKind']);

function abortError() { const error = new Error('媒体任务已停止'); error.name = 'AbortError'; return error; }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
function mediaError(code, message) { return Object.assign(new Error(message), { code }); }
function identifyMedia(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { kind:'image', extension:'png', mime:'image/png', width:bytes.readUInt32BE(16), height:bytes.readUInt32BE(20) };
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { kind:'image', extension:'jpg', mime:'image/jpeg' };
  if (bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return { kind:'image', extension:'webp', mime:'image/webp' };
  if (bytes.length >= 10 && /GIF8[79]a/.test(bytes.toString('ascii',0,6))) return { kind:'image', extension:'gif', mime:'image/gif', width:bytes.readUInt16LE(6), height:bytes.readUInt16LE(8) };
  if (bytes.length >= 16 && bytes.toString('ascii',4,8) === 'ftyp') {
    const brands = bytes.toString('ascii',8,Math.min(bytes.length,40));
    if (/avif|avis/.test(brands)) return { kind:'image', extension:'avif', mime:'image/avif' };
    return { kind:'video', extension:'mp4', mime:'video/mp4' };
  }
  if (bytes.length > 8 && bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) && bytes.subarray(0,4096).includes(Buffer.from('webm'))) return { kind:'video', extension:'webm', mime:'video/webm' };
  throw mediaError('INVALID_MEDIA', '返回内容不是支持的图片或视频');
}

class MediaService {
  constructor(options = {}) {
    if (!options.userDataDir || typeof options.resolveRuntime !== 'function') throw new Error('MediaService requires userDataDir and resolveRuntime');
    this.resolveRuntime = options.resolveRuntime;
    this.resolveCredential = options.resolveCredential;
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.protocols = options.protocols || require('./media-protocols');
    this.store = options.store || new MediaTaskStore(options);
    this.now = options.now || Date.now;
    this.sleep = options.sleep || delay;
    this.onChanged = options.onChanged;
    this.isShuttingDown = options.isShuttingDown || (() => false);
    this.outputDir = options.outputDir || path.join(options.userDataDir, 'generated_images');
    this.pollIntervalMs = options.pollIntervalMs ?? 15000;
    this.maxPollAttempts = options.maxPollAttempts ?? 120;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60000;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 90000;
    this.maxResponseBytes = options.maxResponseBytes ?? 160 * 1024 * 1024;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 128 * 1024 * 1024;
    this.maxInputBytes = options.maxInputBytes ?? 32 * 1024 * 1024;
    this.allowHttpDownloads = options.allowHttpDownloads === true;
    this.verifyMedia = options.verifyMedia;
    this.tasks = new Map();
    this.payloads = new Map();
    this.running = new Map();
    this.controllers = new Map();
    this.suspending = new Set();
    this.credentials = new Map();
    this.startQueue = Promise.resolve();
  }

  _date() { return new Date(this.now()).toISOString(); }
  _clean(value) {
    if (value == null) return value;
    let text = String(value);
    for (const key of this.credentials.values()) if (key) text = text.split(key).join('[redacted]');
    return text.replace(/https?:\/\/[^\s"'<>]+/g, '[remote URL]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 1200);
  }
  _error(error, fallback = 'MEDIA_ERROR') {
    const result = { code: this._clean(error?.code || fallback), message: this._clean(error?.message || '媒体任务未完成'), ...(error?.category ? { category: this._clean(error.category) } : {}) };
    if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) result.status = error.status;
    for (const field of ['providerCode', 'requestId']) {
      const value = error?.[field];
      if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) && this._clean(value) === value) result[field] = value;
    }
    if (/^(?:invalid[ _]request(?: error)?|bad[ _]request)[.!。]?$/i.test(result.message.trim())) {
      result.message = result.code === 'invalid_request' ? '服务商拒绝了请求，未返回具体原因' : '请求未完成，服务商未返回具体原因';
    }
    const details = [result.status && `HTTP ${result.status}`, result.providerCode && `错误码 ${result.providerCode}`, result.requestId && `请求 ID ${result.requestId}`].filter(Boolean);
    if (details.length) result.message += `\n${details.join(' · ')}`;
    return result;
  }
  _snapshot(runtime) {
    const source = { ...runtime, ...(runtime.binding || {}) };
    const snapshot = Object.fromEntries(snapshotFields.filter(key => source[key] !== undefined).map(key => [key, clone(source[key])]));
    const base = new URL(snapshot.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || /(?:key|token|signature|credential|secret)=/i.test(base.search)) throw mediaError('INVALID_MEDIA_ENDPOINT', '服务商地址不能包含凭据');
    if (Object.keys(snapshot.routeHeaders || {}).some(forbiddenHeader)) throw mediaError('INVALID_MEDIA_HEADERS', '鉴权信息必须通过凭据引用配置');
    const credentialHeader = snapshot.auth?.headerName;
    if (credentialHeader && Object.keys(snapshot.routeHeaders || {}).some(name => name.toLowerCase() === credentialHeader.toLowerCase())) throw mediaError('INVALID_MEDIA_HEADERS', '路由头不能包含鉴权信息');
    for (const endpoint of Object.values(snapshot.endpoints || {})) {
      const endpointUrl = typeof endpoint === 'string' ? endpoint : endpoint?.url || endpoint?.path;
      if (endpointUrl && /[?&](?:api[-_]?key|token|signature|credential|secret|auth)=/i.test(endpointUrl)) throw mediaError('INVALID_MEDIA_ENDPOINT', '接口地址不能包含持久化凭据');
    }
    return snapshot;
  }
  async _save(task) {
    task.updatedAt = this._date();
    const stored = await this.store.save(task, this.payloads.get(task.id));
    task.payloadPersistence = stored.payloadPersistence;
    if (this.onChanged) { try { await this.onChanged(clone(task)); } catch (_) {} }
    return clone(task);
  }
  async _load(id) {
    if (this.tasks.has(id)) return this.tasks.get(id);
    const record = await this.store.load(id);
    if (!record) return null;
    this.tasks.set(id, record.task);
    if (record.payload) this.payloads.set(id, record.payload);
    return record.task;
  }
  async get(id) { const task = await this._load(id); return task ? clone(task) : null; }
  async list(filter = {}) { return this.store.list(filter); }
  async attachRun(id, runId) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(runId)) throw mediaError('INVALID_RUN_ID', '运行记录 ID 无效');
    const task = await this._load(id);
    if (!task) throw mediaError('MEDIA_TASK_NOT_FOUND', '媒体任务不存在');
    task.runId = runId;
    return this._save(task);
  }

  async start(input = {}) {
    // Serial admission also prevents two concurrent callers using the same runId.
    const admission = this.startQueue.catch(() => {}).then(async () => {
      const id = input.taskId || input.runId || randomUUID();
      const existing = await this._load(id);
      if (existing) return clone(existing);
      checkAbort(input.signal);
      const runtime = await this.resolveRuntime(input.selection ?? input.model);
      if (!runtime) throw mediaError('MEDIA_RUNTIME_UNAVAILABLE', '未找到可用媒体模型');
      const snapshot = this._snapshot(runtime);
      if (input.expectedMediaKind && this.protocols.getProtocolDefinitions().find(item => item.id === snapshot.protocol)?.modality !== input.expectedMediaKind) {
        throw mediaError('MEDIA_CONFIGURATION_CHANGED', '排队期间模型类型已变更，请重新选择模型后生成');
      }
      const plain = Object.fromEntries(Object.entries(input).filter(([key]) => !controlFields.has(key)));
      const checked = this.protocols.validateInput(snapshot, plain);
      if (!checked.ok) throw mediaError('MEDIA_INPUT_INVALID', checked.errors.map(error => typeof error === 'string' ? error : error.message || error.code).join('；'));
      const normalized = checked.normalizedInput || plain;
      const task = { id, taskId:id, runId:input.runId || null, conversationId:input.conversationId || null,
        turnIndex:Number.isSafeInteger(input.turnIndex) ? input.turnIndex : null,
        source:input.source ? Object.fromEntries(['type','runId','conversationId','turnIndex'].filter(key => own(input.source,key)).map(key => [key,input.source[key]])) : null,
        createdAt:this._date(), updatedAt:this._date(), state:'queued', remoteState:null, submissionOutcome:'not_sent',
        operation:normalized.operation || snapshot.capabilities?.operations?.[0] || 'text_to_image',
        mediaKind:(normalized.operation || snapshot.capabilities?.operations?.[0] || '').includes('video') ? 'video' : 'image',
        snapshot, remoteHandle:null, artifacts:[], error:null, cancelIntent:false };
      this.tasks.set(id, task);
      this.payloads.set(id, { input:clone(normalized), outputs:[] });
      const key = runtime.apiKey || runtime.binding?.apiKey;
      if (typeof key === 'string') this.credentials.set(id, key);
      await this._save(task);
      this._launch(task, controller => this._submit(task, controller.signal), input.signal);
      return clone(task);
    });
    this.startQueue = admission;
    return admission;
  }

  _launch(task, action, inheritedSignal) {
    if (task.cancelIntent || this.running.has(task.id)) return;
    this.suspending.delete(task.id);
    const controller = new AbortController();
    const abort = () => { (this.isShuttingDown() ? this.suspend(task.id) : this.stop(task.id)).catch(() => {}); };
    this.controllers.set(task.id, controller);
    if (inheritedSignal?.aborted) { if (this.isShuttingDown()) this.suspending.add(task.id); controller.abort(); }
    else inheritedSignal?.addEventListener('abort', abort, { once:true });
    const work = Promise.resolve().then(() => action(controller)).catch(async error => {
      if (task.cancelIntent || (controller.signal.aborted && !this.suspending.has(task.id))) task.state = 'stopped';
      else if (this.suspending.has(task.id)) this._suspendState(task);
      else { task.state = 'needs_attention'; task.error = this._error(error); }
      try { await this._save(task); } catch (_) { /* Keep the in-memory failure observable if disk writes fail. */ }
    }).finally(() => {
      inheritedSignal?.removeEventListener('abort', abort);
      this.controllers.delete(task.id); this.running.delete(task.id); this.credentials.delete(task.id); this.suspending.delete(task.id);
    });
    this.running.set(task.id, work);
  }

  async generate(input = {}) {
    try {
      const task = await this.start(input);
      const final = await this.wait(task.id);
      return { ok:final.state === 'completed', paths:final.artifacts.map(item => item.path), artifacts:final.artifacts,
        taskId:final.id, mediaKind:final.mediaKind, ...(final.state !== 'completed' ? { error:final.error?.message || (final.state === 'stopped' ? '媒体任务已停止' : '媒体任务未完成'), code:final.error?.code || final.state, canceled:final.state === 'stopped' } : {}) };
    } catch (error) { return { ok:false, paths:[], error:this._clean(error.message), code:error.code || 'MEDIA_ERROR', canceled:error.name === 'AbortError' }; }
  }
  async wait(id) {
    if (this.running.has(id)) await this.running.get(id);
    return this.get(id);
  }
  async stop(id) {
    const task = await this._load(id);
    if (!task || ['completed','failed'].includes(task.state)) return task ? clone(task) : null;
    task.cancelIntent = true;
    if (task.state === 'submitting') task.submissionOutcome = 'submission_unknown';
    task.state = 'stopped';
    const running = this.running.get(id);
    this.controllers.get(id)?.abort();
    await this._save(task);
    // Resume must not race the aborted worker's cleanup, including when a
    // restored view has no original generate promise to wait for.
    if (running) await running;
    return clone(task);
  }

  _suspendState(task) {
    if (task.cancelIntent) { task.state = 'stopped'; return; }
    if (task.remoteHandle) task.state = task.remoteState === 'succeeded' ? 'downloading' : 'accepted';
    else task.state = task.submissionOutcome === 'submission_unknown' ? 'submission_unknown' : 'needs_attention';
    task.error = { code:'MEDIA_TASK_SUSPENDED', message:'任务已保存，重启后可继续查询或下载；不会重新提交生成' };
  }
  async suspend(id) {
    const task = await this._load(id);
    if (!task || ['completed','failed','stopped'].includes(task.state)) return task ? clone(task) : null;
    // App shutdown interrupts local work but is not a request to cancel the job.
    this.suspending.add(id);
    this.controllers.get(id)?.abort();
    this._suspendState(task);
    return this._save(task);
  }

  async resume(id) {
    if (id === undefined) {
      const tasks = await this.list();
      const restored = [];
      for (const task of tasks) if (!['completed','failed','stopped'].includes(task.state)) restored.push(await this.resume(task.id));
      return restored;
    }
    const task = await this._load(id);
    if (!task || this.running.has(id) || ['completed','failed'].includes(task.state)) return task ? clone(task) : null;
    if (!task.remoteHandle) {
      if (task.remoteState === 'succeeded' && this.payloads.get(id)?.outputs?.length) return this.retryDownload(id);
      task.state = task.submissionOutcome === 'submission_unknown' || task.state === 'submitting' ? 'submission_unknown' : 'needs_attention';
      task.error = { code:'MEDIA_RESUBMISSION_BLOCKED', message:'任务无法自动恢复；为避免重复生成，未重新提交' };
      return this._save(task);
    }
    task.cancelIntent = false; task.error = null;
    task.state = task.remoteState === 'succeeded' ? 'downloading' : 'accepted';
    await this._save(task);
    this._launch(task, controller => this._poll(task, controller.signal));
    return clone(task);
  }
  async retryDownload(id) {
    const task = await this._load(id);
    if (!task || this.running.has(id) || task.state === 'completed') return task ? clone(task) : null;
    if (task.remoteState !== 'succeeded') throw mediaError('MEDIA_NOT_COMPLETED', '远端任务尚未成功，不能重试下载');
    task.cancelIntent = false; task.error = null; task.state = 'downloading';
    await this._save(task);
    this._launch(task, async controller => {
      const outputs = this.payloads.get(id)?.outputs;
      if (outputs?.length) await this._download(task, controller.signal);
      else if (task.remoteHandle) await this._poll(task, controller.signal);
      else { task.state = 'needs_attention'; task.error = { code:'MEDIA_OUTPUT_REFERENCE_UNAVAILABLE', message:'下载引用无法恢复，请保留现有文件；未重新生成' }; await this._save(task); }
    });
    return clone(task);
  }

  async _credential(task) {
    let key;
    try { key = this.resolveCredential ? await this.resolveCredential(clone(task.snapshot)) : this.credentials.get(task.id); }
    catch (_) { throw mediaError('MEDIA_CREDENTIAL_CHANGED', '原任务的凭据或连接已变更，需要人工恢复'); }
    // Anonymous routes still need the provider/binding snapshot checked before
    // a request; disabling or replacing one must also stop its saved tasks.
    if (task.snapshot.auth?.mode === 'none') return '';
    if (typeof key !== 'string' || !key) throw mediaError('MEDIA_CREDENTIAL_UNAVAILABLE', '原任务凭据不可用');
    this.credentials.set(task.id, key);
    return key;
  }
  async _request(task, descriptor, signal, beforeSend) {
    const target = new URL(descriptor.url);
    if (target.origin !== new URL(task.snapshot.baseUrl).origin || target.username || target.password) throw mediaError('MEDIA_ENDPOINT_ORIGIN', '媒体接口必须属于保存的服务商地址');
    const headers = { ...(descriptor.headers || {}) };
    const key = await this._credential(task);
    for (const name of Object.keys(headers)) if (forbiddenHeader(name) || name.toLowerCase() === task.snapshot.auth?.headerName?.toLowerCase()) delete headers[name];
    const auth = task.snapshot.auth || { mode:'bearer' };
    if (auth.mode !== 'none') headers[auth.headerName || (auth.mode === 'api-key' || auth.mode === 'header' ? 'x-api-key' : 'Authorization')] = auth.mode === 'bearer' || !auth.mode ? `Bearer ${key}` : key;
    let body;
    if (descriptor.bodyEncoding === 'multipart') {
      body = new FormData();
      for (const [name,value] of Object.entries(descriptor.body?.fields || {})) if (value !== undefined && value !== null) body.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
      let total = 0;
      for (const [index,file] of (descriptor.body?.files || []).entries()) {
        const bytes = await this._inputBytes(file.source, signal); total += bytes.length;
        if (total > this.maxInputBytes) throw mediaError('MEDIA_INPUT_TOO_LARGE', '参考素材超过大小限制');
        const media = identifyMedia(bytes);
        if (media.kind !== 'image') throw mediaError('INVALID_REFERENCE_IMAGE', '编辑参考素材必须是图片');
        body.append(file.field, new Blob([bytes], { type:media.mime }), `reference-${index}.${media.extension}`);
      }
      for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-type') delete headers[name];
    } else if (descriptor.body !== undefined && descriptor.body !== null) {
      body = JSON.stringify(descriptor.body);
      // Header names are case-insensitive. Adding a second spelling makes
      // Fetch join the values, which strict JSON endpoints reject.
      if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      if (Buffer.byteLength(body) > this.maxInputBytes) throw mediaError('MEDIA_INPUT_TOO_LARGE', '媒体请求超过大小限制');
    }
    checkAbort(signal);
    if (beforeSend) await beforeSend();
    return this._fetchBytes(target, { method:descriptor.method, headers, body, redirect:'manual' }, signal, this.requestTimeoutMs, this.maxResponseBytes);
  }

  async _submit(task, signal) {
    checkAbort(signal);
    const input = this.payloads.get(task.id)?.input;
    if (!input) throw mediaError('MEDIA_INPUT_UNAVAILABLE', '任务输入无法恢复');
    const descriptor = this.protocols.encodeSubmit(task.snapshot, input);
    task.state = 'preparing';
    await this._save(task);
    let response;
    try { response = await this._request(task, descriptor, signal, async () => {
      // Persist ambiguity before the first byte of a potentially billable request.
      task.state = 'submitting'; task.submissionOutcome = 'submission_unknown'; await this._save(task);
    }); }
    catch (error) {
      task.state = task.cancelIntent ? 'stopped' : (task.submissionOutcome === 'not_sent' ? 'failed' : 'submission_unknown'); task.error = this._error(error, 'MEDIA_SUBMISSION_UNKNOWN');
      if (this.suspending.has(task.id)) this._suspendState(task);
      await this._save(task); return;
    }
    const parsed = this.protocols.parseSubmit(task.snapshot, this._response(response));
    this._metadata(task, parsed);
    if (parsed.handle) task.remoteHandle = this._handle(parsed.handle, task.snapshot);
    if (parsed.kind === 'accepted') {
      task.submissionOutcome = 'accepted'; task.remoteState = parsed.state || 'queued'; task.state = task.cancelIntent ? 'stopped' : 'accepted';
      if (['failed','cancelled','canceled','expired'].includes(parsed.state)) {
        task.state = 'failed'; task.error = this._error(parsed.error, 'MEDIA_REMOTE_FAILED'); await this._save(task); return;
      }
      await this._save(task); if (!task.cancelIntent) await this._poll(task, signal); return;
    }
    if (parsed.kind === 'completed') {
      task.submissionOutcome = 'completed'; task.remoteState = 'succeeded';
      this.payloads.get(task.id).outputs = parsed.outputs || [];
      task.state = task.cancelIntent ? 'stopped' : 'downloading';
      await this._save(task); if (!task.cancelIntent) await this._download(task, signal); return;
    }
    task.submissionOutcome = parsed.kind === 'rejected' ? 'rejected' : 'submission_unknown';
    task.state = task.cancelIntent ? 'stopped' : (parsed.kind === 'rejected' ? 'failed' : 'submission_unknown');
    task.error = this._error(parsed.error, 'MEDIA_SUBMISSION_UNKNOWN');
    await this._save(task);
  }
  _handle(handle, snapshot) {
    if (typeof handle.taskId !== 'string' || !handle.taskId.trim() || handle.taskId.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(handle.taskId)) throw mediaError('INVALID_MEDIA_HANDLE', '服务商未返回有效任务 ID');
    return { taskId:handle.taskId, modelId:handle.modelId || snapshot.modelId };
  }
  _metadata(task, parsed) {
    const fields = Object.fromEntries(['usage','resolvedModelId','requestId'].filter(key => parsed[key] !== undefined).map(key => [key,parsed[key]]));
    task.remoteMetadata = { ...(task.remoteMetadata || {}), ...JSON.parse(JSON.stringify(fields, (_key,value) => typeof value === 'string' ? this._clean(value) : value)) };
  }
  _response(response) {
    let body;
    try { body = JSON.parse(response.bytes.toString('utf8')); } catch (_) { body = null; }
    return { status:response.status, headers:response.headers, body };
  }
  async _poll(task, signal) {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      checkAbort(signal);
      let response, parsed;
      try {
        response = await this._request(task, this.protocols.encodePoll(task.snapshot, task.remoteHandle), signal);
        parsed = this.protocols.parsePoll(task.snapshot, this._response(response));
      } catch (error) {
        checkAbort(signal);
        if (String(error.code || '').startsWith('MEDIA_CREDENTIAL') || error.code === 'MEDIA_ENDPOINT_ORIGIN') throw error;
        task.error = this._error(error, 'MEDIA_POLL_RETRY'); await this._save(task);
        await this.sleep(Math.min(this.pollIntervalMs * (attempt + 1), 60000), signal); continue;
      }
      this._metadata(task, parsed);
      if (parsed.handle) task.remoteHandle = this._handle(parsed.handle, task.snapshot);
      if (parsed.state === 'succeeded') {
        task.remoteState = 'succeeded'; task.state = task.cancelIntent ? 'stopped' : 'downloading'; task.error = null;
        const payload = this.payloads.get(task.id) || { outputs:[] };
        payload.outputs = parsed.outputs || []; this.payloads.set(task.id,payload);
        await this._save(task); if (!task.cancelIntent) await this._download(task,signal); return;
      }
      if (['failed','cancelled','canceled','expired'].includes(parsed.state)) {
        task.remoteState = parsed.state; task.state = 'failed'; task.error = this._error(parsed.error, 'MEDIA_REMOTE_FAILED'); await this._save(task); return;
      }
      if (['queued','pending','running'].includes(parsed.state)) {
        task.remoteState = parsed.state; task.state = parsed.state === 'running' ? 'running' : 'accepted'; task.error = null;
      } else if (!parsed.error?.retryable) {
        task.state = 'needs_attention'; task.error = this._error(parsed.error, 'MEDIA_REMOTE_STATE_UNKNOWN'); await this._save(task); return;
      } else task.error = this._error(parsed.error, 'MEDIA_POLL_RETRY');
      await this._save(task);
      const retryAfter = response.headers['retry-after'];
      const retryMs = retryAfter ? (/^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter)*1000 : Date.parse(retryAfter)-this.now()) : 0;
      await this.sleep(Math.max(this.pollIntervalMs, Math.min(Number.isFinite(retryMs) ? retryMs : 0, 300000)), signal);
    }
    task.state = 'needs_attention'; task.error = { code:'MEDIA_POLL_LIMIT', message:'任务仍未取得最终结果，可继续查询原任务；未重新生成' }; await this._save(task);
  }

  async _fetchBytes(url, init, signal, timeoutMs, maximum) {
    checkAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort',abort,{ once:true });
    const timer = setTimeout(abort,timeoutMs);
    try {
      const response = await this.fetch(String(url), { ...init, signal:controller.signal });
      const headers = Object.fromEntries(response.headers.entries());
      if (Number(headers['content-length']) > maximum) { await response.body?.cancel(); throw mediaError('MEDIA_RESPONSE_TOO_LARGE','媒体响应超过大小限制'); }
      const chunks = []; let length = 0;
      if (response.body) for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maximum) { controller.abort(); throw mediaError('MEDIA_RESPONSE_TOO_LARGE','媒体响应超过大小限制'); }
        chunks.push(Buffer.from(chunk));
      }
      return { status:response.status, headers, bytes:Buffer.concat(chunks) };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
  }
  _downloadUrl(value) {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(this.allowHttpDownloads && url.protocol === 'http:')) || url.username || url.password) throw mediaError('MEDIA_DOWNLOAD_URL','媒体下载地址无效');
    if (!this.allowHttpDownloads && /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|fc|fd|fe80))/i.test(url.hostname)) throw mediaError('MEDIA_DOWNLOAD_URL','媒体下载地址不能指向本地网络');
    return url;
  }
  async _downloadBytes(value, signal, maximum = this.maxDownloadBytes) {
    let url = this._downloadUrl(value);
    for (let redirects = 0; redirects <= 3; redirects++) {
      // No gateway credentials or cookies are forwarded to output hosts.
      const response = await this._fetchBytes(url, { method:'GET', redirect:'manual' }, signal, this.downloadTimeoutMs, maximum);
      if ([301,302,303,307,308].includes(response.status)) {
        if (!response.headers.location || redirects === 3) throw mediaError('MEDIA_REDIRECT_LIMIT','媒体下载重定向异常');
        url = this._downloadUrl(new URL(response.headers.location,url).href); continue;
      }
      if (response.status < 200 || response.status >= 300) throw mediaError('MEDIA_DOWNLOAD_HTTP', `媒体下载失败（HTTP ${response.status}）`);
      return response.bytes;
    }
    throw mediaError('MEDIA_REDIRECT_LIMIT','媒体下载重定向异常');
  }
  async _inputBytes(value, signal) {
    if (typeof value !== 'string') throw mediaError('INVALID_REFERENCE','参考素材无效');
    if (value.startsWith('data:')) {
      const match = /^data:[^;,]+;base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(value);
      if (!match || match[1].length > Math.ceil(this.maxInputBytes*4/3)+4) throw mediaError('MEDIA_INPUT_TOO_LARGE','参考素材无效或超过大小限制');
      const bytes = Buffer.from(match[1],'base64');
      if (bytes.length > this.maxInputBytes) throw mediaError('MEDIA_INPUT_TOO_LARGE','参考素材超过大小限制');
      return bytes;
    }
    return this._downloadBytes(value,signal,this.maxInputBytes);
  }
  async _download(task, signal) {
    const outputs = this.payloads.get(task.id)?.outputs || [];
    if (!outputs.length || outputs.length > 32) throw mediaError('MEDIA_OUTPUT_MISSING','服务商未返回可用媒体结果');
    await fs.mkdir(this.outputDir,{ recursive:true });
    let failed = false;
    for (let index = 0; index < outputs.length; index++) {
      checkAbort(signal);
      const prior = task.artifacts.find(item => item.outputIndex === index);
      if (prior) {
        try { if (hash(await fs.readFile(prior.path)) === prior.sha256) continue; } catch (_) {}
        task.artifacts = task.artifacts.filter(item => item.outputIndex !== index);
      }
      const output = outputs[index];
      try {
        let bytes;
        if (output.kind === 'url') bytes = await this._downloadBytes(output.value,signal);
        else if (output.kind === 'base64') {
          if (typeof output.value !== 'string' || output.value.length > Math.ceil(this.maxDownloadBytes*4/3)+4 || !/^[a-zA-Z0-9+/=\r\n]+$/.test(output.value)) throw mediaError('INVALID_MEDIA_BASE64','媒体结果无效或超过大小限制');
          bytes = Buffer.from(output.value,'base64');
        } else throw mediaError('INVALID_MEDIA_OUTPUT','无法识别媒体结果');
        if (!bytes.length || bytes.length > this.maxDownloadBytes) throw mediaError('INVALID_MEDIA_SIZE','媒体结果为空或超过大小限制');
        const media = identifyMedia(bytes);
        if (media.kind !== task.mediaKind) throw mediaError('MEDIA_KIND_MISMATCH','返回的媒体类型与任务不符');
        if (this.verifyMedia) await this.verifyMedia(bytes,media);
        const file = path.join(this.outputDir,`media-${task.id}-${index}.${media.extension}`);
        const temp = `${file}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temp,bytes,{ flag:'wx',mode:0o600 }); await fs.rename(temp,file); }
        finally { await fs.unlink(temp).catch(() => {}); }
        task.artifacts.push({ outputIndex:index, path:file, filePath:file, mime:media.mime, mimeType:media.mime, kind:media.kind,
          bytes:bytes.length, sha256:hash(bytes), ...(media.width ? { width:media.width,height:media.height } : {}) });
        await this._save(task);
      } catch (error) {
        checkAbort(signal); failed = true; task.error = this._error(error,'MEDIA_DOWNLOAD_FAILED');
      }
    }
    task.state = failed ? 'needs_attention' : 'completed';
    if (!failed) task.error = null;
    await this._save(task);
  }
}

module.exports = { MediaService, identifyMedia };
