'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validConversationId, workspaceKey, directoryValue } = require('./conversation-workspaces');

// Project membership is authoritative outside renderer history snapshots. A late
// save cannot move a conversation back into a previously selected directory.
function createProjectStore({ filePath, isBusy = () => false } = {}) {
  let data;
  const clone = value => JSON.parse(JSON.stringify(value));
  function read() {
    if (data) return data;
    if (!filePath || !fs.existsSync(filePath)) return (data = { version: 1, projects: [], bindings: {} });
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.projects) || !value.bindings || typeof value.bindings !== 'object') throw Error('项目记录无法读取，请保留原文件后检查');
    return (data = value);
  }
  function commit(next) {
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temp = filePath + '.tmp'; fs.writeFileSync(temp, JSON.stringify(next, null, 2)); fs.renameSync(temp, filePath);
    }
    data = next;
  }
  function get(id) { return read().projects.find(item => item.id === id) || null; }
  function prepareProject(folder, name, { legacy = false } = {}, snapshot = read()) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw Error('请选择项目文件夹');
    const root = path.resolve(folder);
    if (!legacy && !fs.statSync(root).isDirectory()) throw Error('项目路径必须是文件夹');
    const existing = snapshot.projects.find(item => workspaceKey(item.path) === workspaceKey(root));
    if (existing) return { project: existing, created: false };
    const project = { id: crypto.randomUUID(), name: String(name || path.basename(root) || root).trim().slice(0, 80), path: root, createdAt: new Date().toISOString() };
    return { project, created: true };
  }
  function add(folder, name, options) {
    const { project, created } = prepareProject(folder, name, options);
    if (!created) return clone(project);
    const next = clone(read()); next.projects.push(project); commit(next); return clone(project);
  }
  function binding(id) { return Object.prototype.hasOwnProperty.call(read().bindings, id) ? read().bindings[id] : undefined; }
  function bind(id, projectId, { force = false, beforeCommit, rebind = false } = {}) {
    if (!validConversationId(id)) throw Error('对话标识无效');
    if (projectId != null && !get(projectId)) throw Error('项目不存在，请重新选择');
    const selected = projectId || null;
    if (binding(id) === selected && !rebind) return selected;
    if (!force && isBusy(id)) throw Error('当前对话正在运行，请结束任务后再切换项目');
    if (beforeCommit) beforeCommit();
    const next = clone(read()); next.bindings[id] = selected; commit(next); return selected;
  }
  function adoptMany(conversations) {
    const current = read();
    let next = null, adopted = 0;
    // Consume history lazily. Only registry metadata is staged; no transcript
    // objects are retained and no disk writes happen until iteration succeeds.
    for (const conversation of conversations) {
      if (!conversation || !validConversationId(conversation.id)) continue;
      const snapshot = next || current;
      if (Object.prototype.hasOwnProperty.call(snapshot.bindings, conversation.id)
        && snapshot.bindings[conversation.id] !== undefined) continue;
      let id = conversation.projectId || null;
      if (id && !snapshot.projects.some(project => project.id === id)) throw Error('该对话的项目已移除，请重新选择');
      const legacy = directoryValue(conversation.workingDir);
      if (!id && legacy && !conversation.sdkForkWorkspace) {
        const { project, created } = prepareProject(legacy, null, { legacy: true }, snapshot);
        if (created) { next ||= clone(current); next.projects.push(project); }
        id = project.id;
      }
      next ||= clone(current);
      next.bindings[conversation.id] = id;
      adopted++;
    }
    if (next) commit(next);
    return adopted;
  }
  function adopt(conversation) {
    if (!conversation || !validConversationId(conversation.id)) return null;
    adoptMany([conversation]);
    return binding(conversation.id);
  }
  function decorate(conversation) {
    if (!conversation) return conversation;
    const projectId = binding(conversation.id);
    if (projectId === undefined) return conversation;
    const project = projectId && get(projectId);
    return { ...conversation, projectId: project ? project.id : null,
      workingDir: project ? { path: project.path, name: project.name }
        : conversation.sdkForkWorkspace ? { path: conversation.sdkForkWorkspace.path, name: '原对话工作目录' } : null };
  }
  function rename(id, value) {
    const name = String(value || '').trim(); if (!name || name.length > 80) throw Error('项目名称需要 1–80 个字符');
    if (!get(id)) throw Error('项目不存在');
    const next = clone(read()); next.projects.find(item => item.id === id).name = name; commit(next); return clone(get(id));
  }
  function remove(id, { beforeCommit } = {}) {
    if (!get(id)) return [];
    const affected = Object.keys(read().bindings).filter(key => read().bindings[key] === id);
    if (affected.some(isBusy)) throw Error('项目中还有运行的任务，请结束后再移除');
    if (beforeCommit) beforeCommit([...affected]);
    const next = clone(read()); next.projects = next.projects.filter(item => item.id !== id);
    for (const key of affected) next.bindings[key] = null;
    commit(next); return affected;
  }
  function resolve(conversationId, requestedId) {
    const saved = binding(conversationId);
    const id = saved === undefined ? requestedId || null : saved;
    if (!id) return null;
    const project = get(id); if (!project) throw Error('项目不存在，请重新选择');
    if (!fs.statSync(project.path).isDirectory()) throw Error('项目文件夹不可用，请检查路径');
    return clone(project);
  }
  return { list: () => clone(read().projects), get, binding, bind, adopt, adoptMany, decorate, add, rename, remove, resolve };
}
module.exports = { createProjectStore };
