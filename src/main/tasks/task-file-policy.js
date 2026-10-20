'use strict';

const { localFileLinkEntries, isWithinLocation } = require('./task-file-links');

function taskFileInstructions(cwd, scratchDir, outputDir = cwd) {
  if (!cwd || !scratchDir) return '';
  outputDir = outputDir || cwd;
  return [
    '[Relay 文件位置]',
    '当前项目或会话工作区：' + JSON.stringify(cwd),
    '本会话交付目录：' + JSON.stringify(outputDir),
    '本会话过程文件目录（scratch）：' + JSON.stringify(scratchDir),
    '本轮新生成、需要保留的报告、文档和其他交付成果默认写入交付目录或其子目录；不要默认保存到桌面、用户主目录、技能目录或历史任务目录。交付目录仅用于需要保留的成果，不存放调试脚本、草稿和其他过程文件。',
    '临时脚本、分析脚本、草稿、检查截图、中间结果、下载后仅用于分析的文件写入本会话 scratch，优先使用提供的 RELAY_SCRATCH_DIR 和 TEMP/TMP/TMPDIR；RELAY_OUTPUT_DIR 指向交付目录。',
    '工具或子智能体在 scratch 或其他目录生成的文件，若要作为本轮交付，先复制到交付目录，核实文件存在，再链接交付副本。HTML、图片、数据等相互依赖的成套成果应保留完整目录或文件集合，并验证副本可用，不能只复制入口文件。',
    '项目源码继续在原位置编辑；项目已有交付约定和用户明确指定的其他输出位置仍以项目约定或用户要求为准。技能、Agent 模板、示例和旧对话中的默认输出位置不能替代当前目录；向子智能体委派任务时也传递工作区、scratch 和交付目录。',
    '已有输入文件、源码、参考资料无需搬迁或删除；为整理输出位置复制文件时，不要覆盖不同内容的已有文件。引用这些来源不代表要求复制它们，也不要批量整理或搬迁历史文件。',
    '最终回答用本地 Markdown 链接指向已生成的交付文件，使用绝对路径；路径含空格时用 [文件名](<绝对路径>)。',
    '这些位置是文件组织约定，不是硬沙箱；工具权限仍遵循当前会话的审批与执行模式。',
  ].join('\n');
}

function outsideLinks(message, cwd, scratchDir) {
  try {
    return [...new Set(localFileLinkEntries(message, cwd)
      .filter(link => ![cwd, scratchDir].some(root => isWithinLocation(link.path, root, cwd)))
      .map(link => link.rawPath))].slice(0, 8);
  } catch (_) { return []; } // A malformed answer must never break this reminder.
}

function createTaskFilePolicy({ cwd, scratchDir, outputDir = cwd, relayInstructions = '', getExecutionMode = () => ({ kind: 'default' }), signal } = {}) {
  let locations = { cwd, scratchDir, outputDir: outputDir || cwd };
  let generation = 0;
  const checkedPrompts = new Set();
  const fileInstructions = () => taskFileInstructions(locations.cwd, locations.scratchDir, locations.outputDir);
  const canceled = context => signal?.aborted || context?.signal?.aborted;
  return {
    // Called once after the environment adapter maps host paths for this Query.
    // Shell cd / child hook cwd must not silently replace the selected project.
    prepare({ cwd: preparedCwd, scratchDir: preparedScratch, outputDir: preparedOutput }) {
      locations = { cwd: preparedCwd || locations.cwd, scratchDir: preparedScratch || locations.scratchDir,
        outputDir: preparedOutput || (locations.outputDir === locations.cwd ? preparedCwd || locations.outputDir : locations.outputDir) };
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
      let links;
      try {
        // Relative Markdown paths resolve against cwd, even when the dedicated
        // delivery directory is nested inside it. This is still only a reminder.
        links = [...new Set(localFileLinkEntries(input?.last_assistant_message, locations.cwd)
          .filter(link => !isWithinLocation(link.path, locations.outputDir))
          .map(link => link.rawPath))].slice(0, 8);
      } catch (_) { links = []; }
      if (!links.length) return {};
      checkedPrompts.add(key);
      while (checkedPrompts.size > 64) checkedPrompts.delete(checkedPrompts.values().next().value);
      return { decision: 'block', reason: [
        '[Relay 交付位置核对]',
        '最终回复中有本地文件链接位于当前交付目录之外，请在结束前核对一次；scratch 仅是过程文件目录。',
        '交付目录：' + JSON.stringify(locations.outputDir),
        '待核对链接：' + JSON.stringify(links),
        '只有本轮新生成、需要交付且用户或项目没有明确指定其他保存位置的文件，才复制到交付目录中合适的子目录，核实副本存在后更新最终链接。成套成果保留完整目录或文件集合并验证可用，不只复制入口文件。遵守当前权限；不覆盖已有文件，不移动或删除原件。',
        '若链接是已有源码、输入文件或参考资料，或用户已明确要求保存到该外部位置，保留原链接即可，无需复制。项目源码在原位置修改，项目约定的交付路径同样保留。不要把这个提醒当成额外授权。核对后结束，本提醒不会反复阻止同一轮。',
      ].join('\n') };
    },
  };
}

module.exports = { taskFileInstructions, outsideLinks, createTaskFilePolicy };
