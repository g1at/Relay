(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.relayWorkspaceFileTypes = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const TYPES = Object.freeze({
    folder: ['文件夹', null], 'folder-open': ['已展开的文件夹', null],
    javascript: ['JavaScript', 'javascript'], typescript: ['TypeScript', 'typescript'], react: ['React', 'javascript'],
    python: ['Python', 'python'], shell: ['命令脚本', 'bash'], code: ['源代码', null],
    markdown: ['Markdown', 'markdown'], config: ['配置文件', null], html: ['HTML', 'xml'], css: ['样式表', 'css'],
    image: ['图片', null], video: ['视频', null], audio: ['音频', null], pdf: ['PDF 文档', null],
    document: ['文档', null], spreadsheet: ['电子表格', null], archive: ['压缩文件', null], binary: ['二进制文件', null], file: ['文件', null],
  });
  const extensions = Object.create(null);
  function register(names, kind, language, label, icon) {
    for (const extension of names.split(' ')) extensions[extension] = { kind, language: language === undefined ? TYPES[kind][1] : language, label: label || TYPES[kind][0], icon: icon || kind };
  }
  register('js mjs cjs', 'javascript'); register('ts mts cts', 'typescript');
  register('jsx', 'react', 'javascript', 'React · JSX'); register('tsx', 'react', 'typescript', 'React · TSX');
  register('py pyw pyi', 'python');
  register('sh bash zsh ksh', 'shell'); register('fish', 'shell', null, 'Fish 脚本');
  register('ps1 psm1 psd1', 'shell', null, 'PowerShell'); register('bat cmd', 'shell', null, 'Windows 命令脚本');
  for (const [names, language, label] of [
    ['c h', 'c', 'C'], ['cpp cc cxx hpp hh hxx', 'cpp', 'C++'], ['cs', 'csharp', 'C#'], ['java', 'java', 'Java'],
    ['kt kts', 'kotlin', 'Kotlin'], ['go', 'go', 'Go'], ['rs', 'rust', 'Rust'], ['rb rake gemspec', 'ruby', 'Ruby'],
    ['php phtml', 'php', 'PHP'], ['lua', 'lua', 'Lua'], ['pl pm', 'perl', 'Perl'], ['r rmd', 'r', 'R'],
    ['swift', 'swift', 'Swift'], ['m mm', 'objectivec', 'Objective-C'], ['sql', 'sql', 'SQL'], ['graphql gql', 'graphql', 'GraphQL'],
    ['vb', 'vbnet', 'Visual Basic'], ['diff patch', 'diff', '差异文件'], ['vue svelte', 'xml', '界面组件'],
    ['dart scala ex exs erl exl clj cljs fs fsx zig asm s cmake gradle', null, '源代码'],
  ]) register(names, 'code', language, label);
  register('md markdown mdown mdx', 'markdown');
  register('json jsonc json5', 'config', 'json', 'JSON / 配置', 'json');
  register('lock', 'config', null, '依赖锁定文件'); register('ipynb', 'code', 'json', 'Jupyter Notebook', 'json');
  register('yaml yml', 'config', 'yaml', 'YAML 配置'); register('toml ini cfg conf properties env', 'config', 'ini', '配置文件');
  register('xml xsd xsl xslt plist resx', 'config', 'xml', 'XML 配置', 'config');
  register('html htm xhtml', 'html'); register('css', 'css'); register('scss', 'css', 'scss', 'SCSS'); register('less', 'css', 'less', 'Less');
  register('sass styl', 'css', null, '样式表');
  register('png jpg jpeg gif webp avif bmp ico icns tiff tif heic heif raw psd ai eps', 'image'); register('svg', 'image', 'xml', 'SVG 图片');
  register('mp4 webm mov mkv avi m4v wmv flv mpeg mpg', 'video');
  register('mp3 wav ogg oga flac m4a aac wma aiff mid midi opus', 'audio');
  register('pdf', 'pdf'); register('doc docx odt rtf pages ppt pptx odp key epub', 'document');
  register('txt text log', 'document', 'plaintext', '纯文本');
  register('xls xlsx xlsm xlsb ods csv tsv numbers parquet', 'spreadsheet');
  register('zip rar 7z tar gz gzip bz2 xz tgz tbz2 txz zst cab ar deb rpm jar war whl', 'archive');
  register('exe dll so dylib bin dat obj o a lib pdb pyc pyo class wasm db sqlite sqlite3 msi dmg iso img', 'binary');

  function describe(value, options = {}) {
    options = options && typeof options === 'object' ? options : {};
    const input = typeof value === 'string' ? value : '';
    const name = input.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
    const lower = name.toLowerCase(), extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
    const result = (kind, extra = {}) => ({ kind, label: TYPES[kind][0], language: TYPES[kind][1], extension, name, icon: kind, ...extra });
    if (options.directory) return result(options.expanded ? 'folder-open' : 'folder');
    if (!name || /[\u0000-\u001f\u007f]/.test(name)) return result('file');
    if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower === 'containerfile') return result('code', { label: '容器构建文件' });
    if (['makefile', 'gnumakefile', 'justfile'].includes(lower)) return result('code', { label: '构建脚本', language: lower === 'justfile' ? null : 'makefile' });
    if (lower === 'cmakelists.txt') return result('code', { label: 'CMake 构建文件' });
    if (['cargo.lock', 'poetry.lock', 'uv.lock'].includes(lower)) return result('config', { label: '依赖锁定文件', language: 'ini' });
    if (lower === 'pipfile.lock') return result('config', { label: '依赖锁定文件', language: 'json', icon: 'json' });
    if (/^\.env(?:\.|$)/.test(lower)) return result('config', { label: '环境配置', language: 'ini' });
    if (['.gitignore', '.gitattributes', '.dockerignore', '.npmignore', '.nvmrc', '.node-version', '.python-version'].includes(lower)) return result('config');
    if (['.editorconfig', '.npmrc', '.yarnrc', '.gitconfig'].includes(lower)) return result('config', { language: 'ini' });
    if (['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zprofile'].includes(lower)) return result('shell');
    if (lower === 'readme' || lower === 'changelog') return result('markdown');
    if (/^(license|licence|copying|notice)(?:\.|$)/.test(lower) && !extensions[extension]) return result('document', { label: '纯文本', language: 'plaintext' });
    const selected = extensions[extension];
    return selected ? result(selected.kind, selected) : result('file');
  }

  // All geometry is bundled and authored here. Filenames never become SVG markup.
  // A shared, lightly folded page keeps document types in one visual family.
  // The marks are deliberately sparse: these shapes also render at 16px.
  const sheet = '<path class="file-icon-sheet" d="M6.5 2.75h7L19.5 8.75v10.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2Z"/><path class="file-icon-fold" d="M13.5 2.75v4a2 2 0 0 0 2 2h4"/>';
  const paper = mark => sheet + mark;
  const tile = '<rect class="file-icon-brand-tile" x="2.5" y="2.5" width="19" height="19" rx="4"/>';
  const label = text => '<text class="file-icon-brand-label" x="12" y="16.5" text-anchor="middle" font-size="11" font-family="Arial, sans-serif" font-weight="700" letter-spacing="-.65">' + text + '</text>';
  const snake = 'M11.4 2.5H9.7C7.4 2.5 6 3.7 6 5.8v1.5h6v1.5H5.8c-2.3 0-3.3 1.4-3.3 3.5v1.6c0 2.2 1.3 3.5 3.5 3.5h1.3v-3c0-2.4 1.5-3.8 3.9-3.8h5V5.8c0-2.1-1.6-3.3-4.8-3.3Z';
  const ICONS = Object.freeze({
    folder: '<path class="file-icon-folder-back" d="M2.5 6a2 2 0 0 1 2-2h4.25l2 2H19.5a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2Z"/><path class="file-icon-folder-front" d="M2.5 9h19v8.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2Z"/>',
    'folder-open': '<path class="file-icon-folder-back" d="M2.5 6a2 2 0 0 1 2-2h4.25l2 2h8.75a2 2 0 0 1 2 2v9.5h-19Z"/><path class="file-icon-folder-front" d="M5.1 9.5h16a1 1 0 0 1 .96 1.28l-2 7.3a2 2 0 0 1-1.92 1.42H3a1 1 0 0 1-.96-1.28l2.1-7.98a1 1 0 0 1 .96-.74Z"/>',
    javascript: tile + label('JS'),
    typescript: tile + label('TS'),
    react: '<ellipse cx="12" cy="12" rx="9.5" ry="3.7"/><ellipse cx="12" cy="12" rx="9.5" ry="3.7" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9.5" ry="3.7" transform="rotate(120 12 12)"/><circle class="file-icon-solid" cx="12" cy="12" r="1.7"/>',
    python: '<path class="file-icon-python-blue" d="' + snake + '"/><path class="file-icon-python-gold" transform="rotate(180 12 12)" d="' + snake + '"/><circle class="file-icon-python-eye-blue" cx="9" cy="5.3" r=".85"/><circle class="file-icon-python-eye-gold" cx="15" cy="18.7" r=".85"/>',
    shell: '<rect class="file-icon-sheet" x="2.5" y="4" width="19" height="16" rx="3.5"/><path class="file-icon-mark" d="m6.5 9 3.5 3-3.5 3m7 1h4.5"/>',
    code: paper('<path class="file-icon-mark" d="m9 12-2.5 2.5L9 17m6-5 2.5 2.5L15 17m-2.4-5.5-1.2 6"/>'),
    markdown: paper('<path class="file-icon-mark" d="M7.5 17v-5l2.5 3 2.5-3v5m3-5v5m-1.5-1.5 1.5 1.5 1.5-1.5"/>'),
    json: paper('<path class="file-icon-mark" d="M9.3 11.5H8.5v2L7 14.5 8.5 15.5v2h.8m5.4-6h.8v2L17 14.5 15.5 15.5v2h-.8"/>'),
    config: paper('<path class="file-icon-mark" d="M8 12.5h8M8 17h8m-5.5-6v3m3 1v3.5"/>'),
    html: paper('<path class="file-icon-mark" d="m9.5 12-3 2.5 3 2.5m5-5 3 2.5-3 2.5"/>'),
    css: paper('<path class="file-icon-mark" d="m10 11.5-1 6m6-6-1 6M7.5 13h9M7 16h9"/>'),
    image: paper('<circle class="file-icon-solid" cx="8.5" cy="10" r="1.3"/><path class="file-icon-landscape" d="m6.5 18 3.5-5 2.5 2.5 2-3 3 5.5Z"/>'),
    video: paper('<path class="file-icon-solid" d="M9 11.5a.5.5 0 0 1 .8-.4l6 3.5a.5.5 0 0 1 0 .8l-6 3.5a.5.5 0 0 1-.8-.4Z"/>'),
    audio: paper('<path class="file-icon-mark" d="M10 17v-6l5-1v6"/><ellipse class="file-icon-solid" cx="8.5" cy="17.5" rx="2" ry="1.5"/><ellipse class="file-icon-solid" cx="13.5" cy="16.5" rx="2" ry="1.5"/>'),
    pdf: paper('<rect class="file-icon-solid" x="2.5" y="11" width="19" height="8" rx="2"/><text class="file-icon-inverse" x="12" y="16.9" text-anchor="middle" font-family="Arial, sans-serif" font-size="7" font-weight="700" letter-spacing=".2">PDF</text>'),
    document: paper('<path class="file-icon-mark" d="M8 11.5h8M8 15h8M8 18.5h5"/>'),
    spreadsheet: paper('<path class="file-icon-mark" d="M7.5 11.5h9v7h-9Zm0 3.5h9m-5-3.5v7"/>'),
    archive: paper('<path class="file-icon-solid" d="M10 3.5h2v2h-2Zm2 2h2v2h-2Zm-2 2h2v2h-2Zm2 2h2v2h-2Zm-2 2h2v2h-2Z"/><rect class="file-icon-mark" x="10" y="15" width="4" height="4" rx="1.3"/>'),
    binary: '<rect class="file-icon-sheet" x="5" y="5" width="14" height="14" rx="3"/><path d="M9 2.5V5m6-2.5V5M9 19v2.5m6-2.5v2.5M2.5 9H5m-2.5 6H5m14-6h2.5M19 15h2.5"/><rect class="file-icon-solid" x="9" y="9" width="6" height="6" rx="1"/>',
    file: sheet,
  });
  function createIcon(value, options = {}) {
    options = options && typeof options === 'object' ? options : {};
    if (typeof document === 'undefined') throw new Error('createIcon requires a document');
    const info = describe(value, options), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('focusable', 'false'); svg.setAttribute('class', 'workspace-file-icon' + (options.className ? ' ' + options.className : ''));
    svg.setAttribute('data-file-kind', info.kind); svg.innerHTML = ICONS[info.icon] || ICONS.file;
    if (options.title) {
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = options.title === true ? info.label : String(options.title); svg.appendChild(title); svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', title.textContent);
    } else svg.setAttribute('aria-hidden', 'true');
    return svg;
  }
  return Object.freeze({ describe, createIcon });
}));
