'use strict';

const enterButton = document.getElementById('btnEnter');
const enterLabel = document.getElementById('enterLabel');
const statusText = document.getElementById('statusText');
const errorText = document.getElementById('errorText');
let entering = false;

enterButton.addEventListener('click', async () => {
  // A pending or completed handoff must never write first-run state twice.
  if (entering) return;
  entering = true;
  enterButton.disabled = true;
  enterButton.setAttribute('aria-busy', 'true');
  enterLabel.textContent = '正在打开…';
  errorText.hidden = true;
  errorText.textContent = '';
  statusText.hidden = false;
  statusText.textContent = '正在打开主界面';

  try {
    if (typeof window.api?.installer?.complete !== 'function') {
      throw new Error('暂时无法连接应用，请关闭此窗口后重新打开 Relay。');
    }
    const result = await window.api.installer.complete();
    // The host acknowledges success only after it creates the main window.
    // An absent result is not evidence of successful setup.
    if (!result || result.ok !== true) {
      throw new Error(result?.message || '暂时无法打开主界面，请重试。');
    }
    statusText.textContent = '正在切换到 Relay';
  } catch (error) {
    entering = false;
    statusText.hidden = true;
    errorText.textContent = error?.message || '暂时无法打开主界面，请重试。';
    errorText.hidden = false;
    enterButton.disabled = false;
    enterButton.removeAttribute('aria-busy');
    enterLabel.textContent = '重试';
    enterButton.focus({ preventScroll: true });
  }
});
