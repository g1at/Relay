'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ACTIONS = new Set(['passwords.list', 'passwords.save', 'passwords.delete', 'passwords.reveal', 'passwords.forOrigin', 'contacts.list', 'contacts.save', 'contacts.delete']);
const MAX_BYTES = 2 * 1024 * 1024, MAX_RECORDS = 2000;
const fail = (code, message) => Object.assign(new Error(message), { code, userVisible: true });
function text(value, limit, label, { optional = false } = {}) {
  if (value == null && optional) return '';
  if (typeof value !== 'string' || value.length > limit || /\0/.test(value)) throw fail('INVALID_RECORD', label + '无效或过长');
  return value.trim();
}
function normalizeOrigin(value) {
  const input = text(value, 2048, '网站地址');
  let url;
  try { url = new URL(input); } catch (_) { throw fail('INVALID_ORIGIN', '请输入完整的网站地址，例如 https://example.com'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw fail('INVALID_ORIGIN', '仅支持不含账号信息的 HTTP 或 HTTPS 网站');
  return url.origin;
}
const metadata = record => ({ recordId: record.recordId, origin: record.origin, username: record.username, createdAt: record.createdAt, updatedAt: record.updatedAt });

// Explicitly managed Relay records only. No system-browser import or passive
// password collection. Every saved field, including contact metadata, is encrypted.
function createBrowserFormStore({ filePath, userDataDir, safeStorage, onChanged = () => {}, now = () => new Date().toISOString(), randomId = () => crypto.randomUUID() } = {}) {
  const file = filePath || (userDataDir && path.join(userDataDir, 'browser', 'forms.enc.json'));
  if (!file) throw new TypeError('Browser form store requires a file path');
  let chain = Promise.resolve();
  function available() {
    try {
      return !!safeStorage?.isEncryptionAvailable?.() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
        && typeof safeStorage.encryptString === 'function' && typeof safeStorage.decryptString === 'function';
    } catch (_) { return false; }
  }
  function requireEncryption() {
    if (!available()) throw fail('ENCRYPTION_UNAVAILABLE', '当前系统无法安全加密，密码和联系人管理暂不可用。Relay 不会以明文保存这些信息。');
  }
  async function read() {
    requireEncryption();
    let content;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_BYTES * 2) throw fail('ENCRYPTED_DATA_UNREADABLE', '本地加密资料无法读取，原文件已保留');
      content = await fs.readFile(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, passwords: [], contacts: [] }; throw error; }
    try {
      const envelope = JSON.parse(content);
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) throw Error('invalid envelope');
      const data = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64')));
      if (data.version !== 1 || !Array.isArray(data.passwords) || !Array.isArray(data.contacts)
        || data.passwords.length + data.contacts.length > MAX_RECORDS) throw Error('invalid records');
      const ids = new Set();
      for (const record of [...data.passwords, ...data.contacts]) {
        if (!record || typeof record.recordId !== 'string' || !record.recordId || ids.has(record.recordId)) throw Error('invalid identity');
        ids.add(record.recordId);
      }
      for (const record of data.passwords) if (normalizeOrigin(record.origin) !== record.origin || typeof record.username !== 'string' || typeof record.password !== 'string') throw Error('invalid password');
      for (const record of data.contacts) if (['name', 'email', 'phone', 'address'].some(key => typeof record[key] !== 'string')) throw Error('invalid contact');
      return data;
    } catch (_) { throw fail('ENCRYPTED_DATA_UNREADABLE', '本地加密资料无法读取，原文件已保留。请在原来的系统账户中重试。'); }
  }
  async function write(data) {
    requireEncryption();
    const plain = JSON.stringify(data);
    if (Buffer.byteLength(plain) > MAX_BYTES || data.passwords.length + data.contacts.length > MAX_RECORDS) throw fail('STORE_LIMIT', '保存的资料过多，请先删除不再使用的记录');
    let encrypted;
    try { encrypted = safeStorage.encryptString(plain); } catch (_) { throw fail('ENCRYPTION_FAILED', '加密失败，修改尚未保存'); }
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw fail('ENCRYPTION_FAILED', '加密失败，修改尚未保存');
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temp, JSON.stringify({ version: 1, ciphertext: encrypted.toString('base64') }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async function perform(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.has(input.action)) throw fail('INVALID_ACTION', '此资料操作不可用');
    const data = await read(), passwordSection = input.action.startsWith('passwords.'), records = passwordSection ? data.passwords : data.contacts;
    const operation = input.action.split('.')[1];
    if (operation === 'list' || operation === 'forOrigin') {
      const origin = operation === 'forOrigin' ? normalizeOrigin(input.origin) : null;
      const items = records.filter(record => !origin || record.origin === origin).map(record => passwordSection ? metadata(record) : { ...record });
      items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return { ok: true, available: true, items };
    }
    const id = input.recordId == null ? null : text(input.recordId, 100, '记录编号');
    const existing = id ? records.find(record => record.recordId === id) : null;
    if (id && !existing) throw fail('RECORD_NOT_FOUND', '这条记录已不存在，请刷新后重试');
    if (operation === 'reveal') {
      if (!existing) throw fail('RECORD_NOT_FOUND', '请选择要查看的密码');
      if (input.origin != null && normalizeOrigin(input.origin) !== existing.origin) throw fail('ORIGIN_MISMATCH', '此密码与当前网站不匹配');
      return { ok: true, ...metadata(existing), password: existing.password };
    }
    if (operation === 'delete') {
      if (!existing) throw fail('RECORD_NOT_FOUND', '请选择要删除的记录');
      records.splice(records.indexOf(existing), 1); await write(data);
      try { onChanged({ section: passwordSection ? 'passwords' : 'contacts' }); } catch (_) {}
      return { ok: true };
    }
    const timestamp = now();
    let record;
    if (passwordSection) {
      const origin = normalizeOrigin(input.origin), username = text(input.username, 500, '用户名', { optional: true });
      const password = input.password === undefined && existing ? existing.password : input.password;
      if (typeof password !== 'string' || !password.length || password.length > 4096 || password.includes('\0')) throw fail('INVALID_RECORD', '请输入密码，最多 4096 个字符');
      record = { recordId: existing?.recordId || randomId(), origin, username, password, createdAt: existing?.createdAt || timestamp, updatedAt: timestamp };
    } else {
      const fields = { name: text(input.name, 100, '姓名', { optional: true }), email: text(input.email, 254, '电子邮箱', { optional: true }), phone: text(input.phone, 100, '电话', { optional: true }), address: text(input.address, 1000, '地址', { optional: true }) };
      if (![fields.name, fields.email, fields.phone].some(Boolean)) throw fail('INVALID_RECORD', '请至少填写姓名、电子邮箱或电话');
      record = { recordId: existing?.recordId || randomId(), ...fields, createdAt: existing?.createdAt || timestamp, updatedAt: timestamp };
    }
    if (existing) records[records.indexOf(existing)] = record; else records.push(record);
    await write(data);
    try { onChanged({ section: passwordSection ? 'passwords' : 'contacts' }); } catch (_) {}
    return { ok: true, item: passwordSection ? metadata(record) : { ...record } };
  }
  return {
    isAvailable: available,
    invoke(input) {
      const task = chain.catch(() => {}).then(() => perform(input)).catch(error => ({ ok: false, code: error.userVisible ? error.code : 'FORM_STORE_FAILED', error: error.userVisible ? error.message : '本地资料暂时无法保存或读取，请重试' }));
      chain = task; return task;
    },
  };
}
module.exports = { createBrowserFormStore, normalizeOrigin };
