/* agent-avatar.js — 离线、确定性的「机器人头像」生成器(bottts 风格)
 *
 * 为什么不直接用 @dicebear:
 *   DiceBear 的 npm 包是 ESM、为打包器设计;Relay 渲染层是无打包的纯 <script>(app.js
 *   非 module),且 vendor 目录沿用「自带库」的约定(marked/highlight 都在 vendor/)。
 *   故这里自带一个零依赖、与 DiceBear 同思路(seed 哈希 → 部件选择 → 确定性配色)的生成器:
 *   同一个 seed(agent 名)永远生成同一张机器人脸,完全离线,不碰 api.dicebear.com,
 *   适配本地优先 + 内网环境。圆形由调用方裁(border-radius:50%,对齐左上角 logo)。
 *
 * 用法:
 *   AgentAvatar.svg('飞书 Agent')         → 返回 SVG 字符串
 *   AgentAvatar.dataUri('飞书 Agent')     → 返回 data:image/svg+xml;... 可直接塞 <img src>
 *   两者都带内存缓存(同名只算一次)。
 */
(function (global) {
  'use strict';

  // FNV-1a 32 位哈希:稳定、跨平台一致,作为部件/配色选择的随机源
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }
  // 由种子派生一个确定性的取值器:每调一次推进一步,取模落到 [0,n)
  function picker(seedNum) {
    let s = seedNum || 1;
    return function (n) {
      // xorshift 推进,保证每次不同但完全由初值决定
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return n ? (s % n) : s;
    };
  }

  // 6 组确定性配色(外壳深底 + 主色 + 眼/口亮色),覆盖 Relay 群聊里的角色色系并留余量
  var PALETTES = [
    { bg: '#04342c', body: '#1d9e75', eye: '#9fe1cb', mouth: '#0f6e56' }, // teal
    { bg: '#26215c', body: '#534ab7', eye: '#eeedfe', mouth: '#7f77dd' }, // purple
    { bg: '#4a1b0c', body: '#d85a30', eye: '#f5c4b3', mouth: '#993c1d' }, // coral
    { bg: '#042c53', body: '#378add', eye: '#b5d4f4', mouth: '#185fa5' }, // blue
    { bg: '#4b1528', body: '#d4537e', eye: '#f4c0d1', mouth: '#993556' }, // pink
    { bg: '#173404', body: '#639922', eye: '#c0dd97', mouth: '#3b6d11' }, // green
  ];

  function buildSvg(seed) {
    var rnd = picker(hash32(String(seed || 'agent')));
    var p = PALETTES[rnd(PALETTES.length)];

    // ── 天线(3 种) ──
    var antType = rnd(3);
    var ant = '';
    if (antType === 0) ant = '<rect x="22" y="5" width="4" height="6" fill="' + p.mouth + '"/><circle cx="24" cy="4" r="2.6" fill="' + p.body + '"/>';
    else if (antType === 1) ant = '<rect x="21" y="6" width="6" height="4" rx="1" fill="' + p.mouth + '"/>';
    else ant = '<circle cx="24" cy="6" r="2.6" fill="' + p.body + '"/><rect x="23" y="8" width="2" height="3" fill="' + p.mouth + '"/>';

    // ── 头壳(3 种圆角) ──
    var headRx = [4, 8, 11][rnd(3)];
    var head = '<rect x="11" y="12" width="26" height="23" rx="' + headRx + '" fill="' + p.body + '"/>';

    // ── 耳/侧件(有/无) ──
    var ears = rnd(2)
      ? '<rect x="8" y="19" width="3.5" height="8" rx="1.75" fill="' + p.mouth + '"/><rect x="36.5" y="19" width="3.5" height="8" rx="1.75" fill="' + p.mouth + '"/>'
      : '';

    // ── 眼睛(4 种) ──
    var eyeType = rnd(4);
    var eyes;
    if (eyeType === 0) eyes = '<circle cx="19" cy="23" r="2.6" fill="' + p.eye + '"/><circle cx="29" cy="23" r="2.6" fill="' + p.eye + '"/>';
    else if (eyeType === 1) eyes = '<circle cx="19" cy="23" r="4" fill="' + p.eye + '"/><circle cx="29" cy="23" r="4" fill="' + p.eye + '"/><circle cx="19" cy="23" r="1.8" fill="' + p.bg + '"/><circle cx="29" cy="23" r="1.8" fill="' + p.bg + '"/>';
    else if (eyeType === 2) eyes = '<rect x="16" y="21" width="6" height="4" rx="1" fill="' + p.eye + '"/><rect x="26" y="21" width="6" height="4" rx="1" fill="' + p.eye + '"/>';
    else eyes = '<rect x="14" y="19" width="20" height="8" rx="3" fill="' + p.bg + '"/><circle cx="20" cy="23" r="2.2" fill="' + p.eye + '"/><circle cx="28" cy="23" r="2.2" fill="' + p.eye + '"/>';

    // ── 嘴(3 种) ──
    var mouthType = rnd(3);
    var mouth;
    if (mouthType === 0) mouth = '<rect x="18" y="30" width="12" height="2.4" rx="1.2" fill="' + p.mouth + '"/>';
    else if (mouthType === 1) mouth = '<rect x="17" y="29" width="14" height="4" rx="2" fill="' + p.mouth + '"/>';
    else mouth = '<rect x="19" y="29" width="2.5" height="3" fill="' + p.mouth + '"/><rect x="23" y="29" width="2.5" height="3" fill="' + p.mouth + '"/><rect x="27" y="29" width="2.5" height="3" fill="' + p.mouth + '"/>';

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">' +
      '<rect width="48" height="48" fill="' + p.bg + '"/>' +
      ant + head + ears + eyes + mouth +
      '</svg>';
  }

  var svgCache = new Map();
  var uriCache = new Map();

  function svg(seed) {
    var key = String(seed == null ? '' : seed);
    if (svgCache.has(key)) return svgCache.get(key);
    var out = buildSvg(key);
    svgCache.set(key, out);
    return out;
  }
  function dataUri(seed) {
    var key = String(seed == null ? '' : seed);
    if (uriCache.has(key)) return uriCache.get(key);
    // encodeURIComponent 比 base64 更省、且无 unicode 坑(种子是 ASCII 但 SVG 里也只有 ASCII)
    var out = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(key));
    uriCache.set(key, out);
    return out;
  }

  global.AgentAvatar = { svg: svg, dataUri: dataUri };
})(typeof window !== 'undefined' ? window : this);
