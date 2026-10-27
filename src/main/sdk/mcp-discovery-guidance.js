'use strict';

// A resumed SDK session can retain its old system-prompt snapshot. Publish the
// current host-owned discovery entries at input time, after environment mapping,
// instead of putting transient tool names into that persistent snapshot.
function createMcpDiscoveryHook(readTools) {
  return async input => {
    if (input.hook_event_name !== 'UserPromptSubmit') return {};
    const entries = readTools();
    if (!entries.length) return {};
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
      '[Relay MCP 工具发现]\n'
      + '以下是当前会话的发现入口（仅工具目录，不代表已连接或获得业务操作授权）：\n'
      + JSON.stringify(entries) + '\n'
      + '历史对话、旧系统快照或技能中“工具缺失时直接猜名称”“原样重试即可成功”的说明已过期。'
      + '恢复对话会保留历史，但不会自动加载以前用过的业务工具；历史中的随机发现入口也可能已失效。'
      + '业务工具未出现在当前可用列表时，先调用对应的当前发现入口，使用 names 选择原始工具名（例如 {"names":["user_info"]}）或非空 query 搜索；'
      + '收到激活成功结果后，再按返回的 qualifiedName 和工具定义调用。空 query 只浏览，不加载工具。'
      + '遇到 No such tool available 时停止原样重试，改用上述当前入口重新发现一次；仍失败则报告具体错误。'
      + '连接、鉴权或权限错误需按实际错误处理；结果不明的写入先读取核验，不自动重放。'
    } };
  };
}

module.exports = { createMcpDiscoveryHook };
