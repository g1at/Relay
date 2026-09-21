'use strict';

// Only the current quick-chat document may read a bitmap from its own saved
// workspace. The renderer cannot choose a project, root or a different chat.
function registerMiniLocalImages({ ipcMain, isCaller, getConversationId, readImage }) {
  ipcMain.handle('mini:readLocalImage', async (event, input = {}) => {
    const denied = () => ({ ok: false, code: 'IMAGE_ACCESS_DENIED', error: '图片不属于当前小窗对话。' });
    if (!isCaller(event)) return denied();
    const id = getConversationId();
    if (!id || (input.context?.conversationId && input.context.conversationId !== id)) return denied();
    const frame = event.senderFrame;
    try {
      const result = await readImage({ href: input.href, basePath: input.basePath, context: { conversationId: id } });
      if (!isCaller(event) || frame !== event.sender.mainFrame || getConversationId() !== id) return denied();
      return result;
    } catch (_) {
      return { ok: false, code: 'IMAGE_UNAVAILABLE', error: '图片已不存在或不在此对话的工作目录内。' };
    }
  });
}

module.exports = { registerMiniLocalImages };
