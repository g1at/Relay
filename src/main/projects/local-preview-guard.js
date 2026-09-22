'use strict';

// srcdoc content may run its own UI, but must not navigate a subframe to a
// privileged file:// renderer or turn a preview click into external navigation.
function attachLocalPreviewGuard(webContents) {
  webContents.on('will-frame-navigate', event => {
    if (event.isMainFrame) return;
    if (event.frame?.url === 'about:srcdoc' || event.frame?.name === 'relay-local-html') event.preventDefault();
  });
}
module.exports = { attachLocalPreviewGuard };
