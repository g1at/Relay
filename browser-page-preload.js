'use strict';

// A presentation-only sandbox preload. Inserting a user stylesheet synchronously
// before parsing prevents a native scrollbar from painting while HTML, scripts
// or stylesheets are still loading. Nothing is exposed to the remote page.
const PAGE_CSS = `
    :where(html, body, body *) { scrollbar-width:auto!important; scrollbar-color:auto!important; }
    :where(html, body, body *)::-webkit-scrollbar { width:9px!important; height:9px!important; background:transparent!important; }
    :where(html, body, body *)::-webkit-scrollbar-track,
    :where(html, body, body *)::-webkit-scrollbar-corner { background:transparent!important; }
    :where(html, body, body *)::-webkit-scrollbar-thumb { background:transparent!important; border:1px solid transparent!important; border-radius:999px!important; background-clip:padding-box!important; }
    [data-relay-scroll-visible]::-webkit-scrollbar-thumb { background-color:#b5b8be!important; }
    [data-relay-scroll-visible][data-relay-scroll-tone="dark"]::-webkit-scrollbar-thumb { background-color:#666c76!important; }
    [data-relay-scroll-visible]::-webkit-scrollbar-thumb:hover { background-color:#858a93!important; }
    [data-relay-scroll-visible][data-relay-scroll-tone="dark"]::-webkit-scrollbar-thumb:hover { background-color:#939aa5!important; }
    :where(html, body, body *)::-webkit-scrollbar-button { display:none!important; width:0!important; height:0!important; }
    @media(forced-colors:active) { [data-relay-scroll-visible]::-webkit-scrollbar-thumb { background-color:GrayText!important; } [data-relay-scroll-visible]::-webkit-scrollbar-thumb:hover { background-color:CanvasText!important; } }
  `;

if (typeof process !== 'undefined' && process.type === 'renderer') {
  const { webFrame } = require('electron');
  webFrame.insertCSS(PAGE_CSS, { cssOrigin: 'user' });
}

module.exports = { PAGE_CSS };
