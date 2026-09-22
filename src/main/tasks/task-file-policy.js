'use strict';

const path = require('node:path');
const marked = require('../../../renderer/vendor/marked.umd.js');
const { parse: parseLocalLink } = require('../../../renderer/local-file-links');

function taskFileInstructions(cwd, scratchDir) {
  if (!cwd || !scratchDir) return '';
  return [
    '[Relay 文件位置]',
    '交付目录（当前项目或会话工作区）：' + JSON.stringify(cwd),
    '本会话过程文件目录（scratch）：' + JSON.stringify(scratchDir),
    '当前选择的项目或会话工作区是新交付文件的默认保存位置。报告、文档、代码和其他需要保留的结果写入交付目录或其子目录；不要默认保存到桌面、用户主目录、技能目录或历史任务目录。',
    '临时脚本、中间结果、下载后仅用于分析的文件写入本会话 scratch，优先使用提供的 TEMP/TMP/TMPDIR。工具或子智能体在 scratch 或其他目录生成的文件，若要作为本轮交付，先复制到交付目录，核实文件存在，再链接交付副本。',
    '技能、Agent 模板、示例和旧对话中的默认输出位置不能替代当前交付目录；向子智能体委派任务时也传递这两个位置。用户明确指定的其他输出位置仍以用户要求为准。',
    '已有输入文件、源码、参考资料无需搬迁或删除；为整理输出位置复制文件时，不要覆盖不同内容的已有文件。引用这些来源不代表要求复制它们。',
    '最终回答用本地 Markdown 链接指向已生成的交付文件，使用绝对路径；路径含空格时用 [文件名](<绝对路径>)。',
    '这些位置是文件组织约定，不是硬沙箱；工具权限仍遵循当前会话的审批与执行模式。',
  ].join('\n');
}

// Compare host Windows paths and their WSL drive aliases consistently. This is
// only a completion reminder; file access still uses the workspace realpath guard.
function locationKey(value, cwd) {
  if (typeof value !== 'string' || !value) return null;
  if (!/^[a-z]:[\\/]/i.test(value) && !/^\\\\/.test(value) && !path.posix.isAbsolute(value)) {
    value = /^[a-z]:[\\/]/i.test(cwd || '') || /^\\\\/.test(cwd || '')
      ? path.win32.resolve(cwd, value) : path.posix.resolve(cwd || '/', value);
  }
  const mounted = /^\/mnt\/([a-z])(?:\/|$)/i.exec(value);
  if (mounted) value = mounted[1] + ':/' + value.slice(mounted[0].length);
  const windows = /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
  if (windows) {
    return 'win:' + path.win32.resolve(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  }
  return 'posix:' + path.posix.resolve(cwd || '/', value).replace(/\/$/, '');
}
function outsideLinks(message, cwd, scratchDir) {
  if (typeof message !== 'string' || !message || message.length > 256 * 1024) return [];
  const roots = [cwd, scratchDir].map(root => locationKey(root)).filter(Boolean);
  const links = new Set();
  try {
    // The lexer understands reference links, angle paths and nested parentheses;
    // fenced/inline code and raw HTML are not treated as delivered file links.
    marked.walkTokens(marked.lexer(message), token => {
      if (links.size >= 8 || !['link', 'image'].includes(token.type)) return;
      const parsed = parseLocalLink(token.href);
      if (!parsed) return;
      const key = locationKey(parsed.path, cwd);
      if (key && !roots.some(root => key === root || key.startsWith(root + '/'))) links.add(parsed.path);
    });
  } catch (_) {} // A malformed answer must never turn this reminder into an error.
  return [...links];
}

function createTaskFilePolicy({ cwd, scratchDir, relayInstructions = '', getExecutionMode = () => ({ kind: 'default' }), signal } = {}) {
  let locations = { cwd, scratchDir };
  let generation = 0;
  const checkedPrompts = new Set();
  const fileInstructions = () => taskFileInstructions(locations.cwd, locations.scratchDir);
  const canceled = context => signal?.aborted || context?.signal?.aborted;
  return {
    // Called once after the environment adapter maps host paths for this Query.
    // Shell cd / child hook cwd must not silently replace the selected project.
    prepare({ cwd: preparedCwd, scratchDir: preparedScratch }) {
      locations = { cwd: preparedCwd || locations.cwd, scratchDir: preparedScratch || locations.scratchDir };
    },
    async delegate(input, _toolId, context) {
      if (canceled(context) || !['Agent', 'Task'].includes(input?.tool_name) || typeof input.tool_input?.prompt !== 'string') return {};
      const prompt = input.tool_input.prompt;
      const missing = [relayInstructions, fileInstructions()].filter(text => text && !prompt.includes(text));
      if (!missing.length) return {};
      // One updatedInput owns both contexts so hooks cannot overwrite each other.
      return { hookSpecificOutput: { hookEventName: 'PreToolUse',
        updatedInput: { ...input.tool_input, prompt: missing.join('\n\n') + '\n\n' + prompt } } };
    },
    async submit(input, _toolId, context) {
      if (canceled(context)) return {};
      if (!input?.agent_id && (!input?.source || ['user', 'sdk'].includes(input.source))) generation++;
      const instructions = fileInstructions();
      return instructions ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: instructions } } : {};
    },
    async stop(input, _toolId, context) {
      if (canceled(context) || input?.agent_id || input?.stop_hook_active || input?.permission_mode === 'plan'
          || getExecutionMode().kind === 'plan' || !fileInstructions()) return {};
      const key = input?.prompt_id || 'turn:' + generation;
      if (checkedPrompts.has(key)) return {};
      const links = outsideLinks(input?.last_assistant_message, locations.cwd);
      if (!links.length) return {};
      checkedPrompts.add(key);
      while (checkedPrompts.size > 64) checkedPrompts.delete(checkedPrompts.values().next().value);
      return { decision: 'block', reason: [
        '[Relay 交付位置核对]',
        '最终回复中有本地文件链接位于当前交付目录之外，请在结束前核对一次；scratch 仅是过程文件目录。',
        '交付目录：' + JSON.stringify(locations.cwd),
        '待核对链接：' + JSON.stringify(links),
        '只有本轮新生成、需要交付且用户没有明确指定外部保存位置的文件，才复制到交付目录中合适的子目录，核实副本存在后更新最终链接。遵守当前权限；不覆盖已有文件，不移动或删除原件。',
        '若链接是已有源码、输入文件或参考资料，或用户已明确要求保存到该外部位置，保留原链接即可，无需复制。不要把这个提醒当成额外授权。核对后结束，本提醒不会反复阻止同一轮。',
      ].join('\n') };
    },
  };
}

module.exports = { taskFileInstructions, outsideLinks, createTaskFilePolicy };
