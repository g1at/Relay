'use strict';

const { createLocatorRuntime } = require('./browser-locator');

// Runs only in a CDP isolated world. The page cannot replace these globals or
// supply JavaScript to this adapter. References retain actual nodes, not selectors.
function pageOperationBody(request, createLocatorRuntime) {
  const fail = (code, message) => ({ error: { code, message } });
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const engine = globalThis.__relayPlaywright;
  const labelText = (label, control) => {
    const read = node => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1 || node === control || node.matches('script,style,[aria-hidden="true"]')) return '';
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      if (node.tagName === 'IMG') return node.alt || '';
      return Array.from(node.childNodes, read).join('');
    };
    return read(label);
  };
  const nameOf = element => normalize(engine?.utils.getElementAccessibleNameText(element, false) || element.getAttribute('aria-label') ||
    (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => element.getRootNode().getElementById?.(id)?.textContent || '').join(' ') ||
    (element.labels ? Array.from(element.labels, label => labelText(label, element)).join(' ') : '') ||
    element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') ||
    ((element.tagName === 'INPUT' && /^(button|submit|reset)$/.test(element.type)) ? element.value : '') || element.innerText || element.textContent).slice(0, 300);
  const roleOf = element => engine ? (engine.utils.getAriaRole(element) || 'generic') : element.getAttribute('role') || ({ BUTTON: 'button', A: 'link', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' }[element.tagName]) ||
    (element.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider' }[element.type] || 'textbox') : element.isContentEditable ? 'textbox' : 'generic');
  const visible = (element, offscreen = false) => {
    // Opacity does not determine actionability: custom controls commonly place
    // a transparent native input over their visual shell. The hit test below
    // still ensures that this actual node receives the requested input.
    if (!element.isConnected || element.ownerDocument !== document || element.closest('[inert]') || element.checkVisibility?.({ checkVisibilityCSS: true }) === false) return false;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && (offscreen || rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth) &&
      style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
  };
  const describe = (element, ref) => {
    const rect = element.getBoundingClientRect();
    const value = { ref, tag: element.tagName.toLowerCase(), role: roleOf(element), name: nameOf(element), disabled: !!element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      visible: visible(element, true), inViewport: visible(element), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    if (element.tagName === 'INPUT') value.type = element.type;
    if ('value' in element && !['password', 'file'].includes(element.type)) value.value = String(element.value).slice(0, 2000);
    if (element.tagName === 'SELECT') {
      value.multiple = element.multiple;
      value.options = Array.from(element.options).slice(0, 100).map(option => ({ value: option.value.slice(0, 2000), label: option.label.slice(0, 300), selected: option.selected, disabled: option.disabled || !!option.closest('optgroup[disabled]') }));
    }
    if (element.type === 'file') { value.multiple = element.multiple; value.accept = element.accept.slice(0, 2000); value.fileCount = element.files?.length || 0; value.directory = element.webkitdirectory || element.hasAttribute('directory'); }
    if ('checked' in element) value.checked = !!element.checked;
    return value;
  };
  const walkAll = root => {
    const elements = root.nodeType === 1 ? [root] : [];
    for (const element of root.querySelectorAll('*')) { elements.push(element); if (element.shadowRoot) elements.push(...walkAll(element.shadowRoot)); }
    return elements;
  };
  const { find } = createLocatorRuntime({ engine, document, visible, nameOf, roleOf });
  const attributeName = request.attributeName;
  if (attributeName !== undefined && (typeof attributeName !== 'string' || !/^[^\s"'<>/=\u0000-\u001f\u007f]{1,200}$/.test(attributeName))) return fail('BROWSER_INVALID_ATTRIBUTE', '属性名无效');
  const isPassword = element => element.tagName === 'INPUT' && element.type === 'password';
  const readState = element => {
    const role = roleOf(element);
    const state = name => engine?.elementState ? engine.elementState(element, name).matches : undefined;
    const enabled = state('enabled') ?? (!element.disabled && !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true');
    const nativeCheck = element.tagName === 'INPUT' && ['checkbox', 'radio'].includes(element.type);
    const ariaCheck = ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role);
    const checked = nativeCheck ? (element.indeterminate ? 'mixed' : !!element.checked) : ariaCheck && element.hasAttribute('aria-checked') ? element.getAttribute('aria-checked') === 'mixed' ? 'mixed' : element.getAttribute('aria-checked') === 'true' : undefined;
    const selected = element.tagName === 'OPTION' ? !!element.selected : ['option', 'tab', 'row', 'treeitem'].includes(role) && element.hasAttribute('aria-selected') ? element.getAttribute('aria-selected') === 'true' : undefined;
    let editable = false;
    const inputEditable = element.tagName === 'TEXTAREA' || element.isContentEditable || (element.tagName === 'INPUT' && /^(text|search|email|tel|url|password|number|date|datetime-local|month|range|time|week)$/.test(element.type));
    if (inputEditable) { try { editable = state('editable') ?? (enabled && !element.readOnly); } catch (_) { editable = false; } }
    return { enabled, editable, checked, selected, ...(attributeName !== undefined ? { attribute: element.getAttribute(attributeName) } : {}) };
  };
  const pageText = root => {
    let text = root.innerText || root.textContent || '';
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) text += '\n' + pageText(element.shadowRoot);
    return text.slice(0, 24000);
  };
  const scope = globalThis.__relayBrowserAutomation;
  if (request.operation === 'viewport') return { width: innerWidth, height: innerHeight };
  if (request.operation === 'read-page') return { url: location.href, title: document.title, readyState: document.readyState, text: pageText(document.body || document.documentElement) };
  if (request.operation === 'query-state') {
    try {
      const matches = find(request.locator);
      const unique = request.wantUnique || request.wantValue || request.wantText || request.wantChecked || request.wantSelected || request.wantEnabled || request.wantEditable || attributeName !== undefined;
      if (unique && matches.length > 1) return fail('BROWSER_LOCATOR_AMBIGUOUS', '元素断言条件必须匹配唯一元素');
      const element = matches[0];
      if (element && isPassword(element) && (request.wantValue || attributeName?.toLowerCase() === 'value')) return fail('BROWSER_PASSWORD_READ_BLOCKED', '不支持读取或比较密码值');
      return { count: matches.length, attached: !!matches.length, visible: matches.some(element => visible(element, true)), enabled: matches.some(element => visible(element, true) && !element.disabled && !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true'),
        ...(element && unique ? readState(element) : {}),
        ...(request.wantValue && element ? { value: 'value' in element ? String(element.value) : element.innerText } : {}),
        ...(request.wantText && element ? { text: element.innerText || element.textContent || '' } : {}) };
    }
    catch (error) { return fail(error.code || 'BROWSER_INVALID_LOCATOR', error.message); }
  }
  if (request.operation === 'observe' || request.operation === 'locate') {
    const state = { id: request.observationId, document, url: location.href, nodes: new Map() };
    const elements = [], frames = [], offset = request.offset ?? 0, limit = request.limit ?? 100;
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 500) return fail('BROWSER_INVALID_OBSERVATION', '观察分页范围无效');
    if (request.format !== undefined && !['list', 'tree'].includes(request.format)) return fail('BROWSER_INVALID_OBSERVATION', '观察格式无效');
    let root = document, activeDialog = null, candidates;
    try {
      if (request.scope) { const roots = find(request.scope); if (roots.length !== 1) return fail(roots.length ? 'BROWSER_LOCATOR_AMBIGUOUS' : 'BROWSER_LOCATOR_NOT_FOUND', '观察范围必须匹配一个元素'); root = roots[0]; }
      else if (request.operation === 'observe') {
        activeDialog = walkAll(document).filter(element => element.matches('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]') && visible(element, true)).at(-1) || null;
        if (activeDialog) root = activeDialog;
      }
      candidates = request.operation === 'locate' ? find(request.locator, root) : walkAll(root).filter(element => visible(element, !!request.includeOffscreen)
        && (element.matches('a[href],button,input:not([type="hidden"]),textarea,select,summary,[contenteditable]:not([contenteditable="false"])') || !['generic', 'none', 'presentation'].includes(roleOf(element)) || (element.tabIndex >= 0 && !['none', 'presentation'].includes(roleOf(element)))));
      if (request.operation === 'observe') { const rank = element => element.matches('button,input,textarea,select,a[href],summary,[contenteditable]:not([contenteditable="false"])') ? 0 : ['dialog', 'alertdialog', 'heading'].includes(roleOf(element)) ? 1 : 2; candidates.sort((a, b) => rank(a) - rank(b)); }
      for (const element of candidates.slice(offset, offset + limit)) {
        const ref = 'e' + (elements.length + 1), description = describe(element, ref);
        state.nodes.set(ref, { element, role: description.role, name: description.name }); elements.push(description);
      }
      for (const element of document.querySelectorAll('iframe,frame')) frames.push({ title: element.title || element.name || '', url: element.src, visible: visible(element) });
    } catch (error) { return fail(error.code || 'BROWSER_INVALID_LOCATOR', error.message); }
    globalThis.__relayBrowserAutomation = state;
    let structure = {};
    if (request.format === 'tree') {
      const tree = [], treeNodes = new Map(), treeLevels = new Map(), treeElements = new Map(), maxNodes = 1000, maxDepth = 24, maxAncestorScan = 96;
      const references = new Map([...state.nodes].map(([ref, stored]) => [stored.element, ref]));
      const containerRoles = new Set(['dialog', 'alertdialog', 'region', 'table', 'grid', 'treegrid', 'rowgroup', 'row', 'group', 'list', 'listitem', 'tree', 'treeitem', 'navigation', 'main', 'form']);
      let truncated = false;
      const parent = element => element.parentElement || element.getRootNode()?.host;
      for (const { element } of state.nodes.values()) {
        const ancestry = [];
        let scanned = 0;
        for (let node = element; node && node !== (root.nodeType === 1 ? parent(root) : null); node = parent(node)) {
          if (++scanned > maxAncestorScan) { truncated = true; break; }
          if (references.has(node) || node === root || containerRoles.has(roleOf(node))) ancestry.unshift(node);
          if (node === root) break;
        }
        let children = tree, level = 0;
        for (const node of ancestry) {
          let entry = treeNodes.get(node);
          if (!entry) {
            if (treeNodes.size >= maxNodes || level >= maxDepth) { truncated = true; break; }
            const reference = references.get(node);
            const { enabled, editable, checked, selected } = readState(node), rawLevel = node.getAttribute('aria-level');
            const ariaLevel = rawLevel !== null && rawLevel.length <= 5 && /^[1-9]\d{0,4}$/.test(rawLevel) && Number(rawLevel) <= 10000 ? Number(rawLevel) : undefined;
            entry = { tag: node.tagName.toLowerCase().slice(0, 100), role: roleOf(node).slice(0, 100), name: nameOf(node), ...(reference ? { ref: reference } : {}),
              enabled, editable, checked, selected, ...(node.hasAttribute('aria-expanded') ? { expanded: node.getAttribute('aria-expanded') === 'true' } : {}),
              ...(ariaLevel === undefined ? {} : { level: ariaLevel }), children: [] };
            treeNodes.set(node, entry); treeLevels.set(entry, level); treeElements.set(entry, node); children.push(entry);
          }
          level = treeLevels.get(entry) + 1; children = entry.children;
        }
      }
      const sortTree = children => { children.sort((a, b) => { const relation = treeElements.get(a).compareDocumentPosition(treeElements.get(b)); return relation & 1 ? 0 : relation & 4 ? -1 : relation & 2 ? 1 : 0; }); for (const entry of children) sortTree(entry.children); };
      sortTree(tree);
      structure = { tree, treeInfo: { kind: 'dom-semantic-tree', maxDepth, maxNodes, maxAncestorScan, nodeCount: treeNodes.size, truncated,
        paginated: offset > 0 || offset + limit < candidates.length } };
    }
    return { observationId: state.id, url: state.url, title: document.title, text: pageText(root === document ? document.body || document.documentElement : root), elements,
      ...(request.operation === 'locate' ? { matches: elements, count: candidates.length, strict: true } : {}), frames,
      ...structure,
      activeDialog: activeDialog ? { role: roleOf(activeDialog), name: nameOf(activeDialog) } : null,
      pagination: { offset, limit, total: candidates.length, hasMore: offset + limit < candidates.length, nextOffset: offset + limit < candidates.length ? offset + limit : null },
      limitations: ['closed-shadow-roots-unsupported', 'references-expire-on-next-observation'] };
  }
  if (!scope || scope.document !== document || scope.url !== location.href || scope.id !== request.observationId) return fail('BROWSER_OBSERVATION_STALE', '页面已变化，请重新观察后操作。');
  if (request.operation === 'assert-document') return { valid: true };
  if (request.operation === 'point') {
    if (![request.x, request.y].every(Number.isFinite) || request.x < 0 || request.y < 0 || request.x >= innerWidth || request.y >= innerHeight) return fail('BROWSER_INVALID_POINT', '坐标不在当前框架视口内');
    return { x: request.x, y: request.y };
  }
  if (request.operation === 'resolve-locator') {
    try {
      const matches = find(request.locator); if (matches.length !== 1) return fail(matches.length ? 'BROWSER_LOCATOR_AMBIGUOUS' : 'BROWSER_LOCATOR_NOT_FOUND', '操作定位条件必须唯一');
      const ref = 'e' + (scope.nodes.size + 1), result = describe(matches[0], ref); scope.nodes.set(ref, { element: matches[0], role: result.role, name: result.name }); return result;
    } catch (error) { return fail(error.code || 'BROWSER_INVALID_LOCATOR', error.message); }
  }
  const entry = scope.nodes.get(request.ref), element = entry?.element;
  if (!element || !element.isConnected || element.ownerDocument !== document) return fail('BROWSER_ELEMENT_STALE', '原元素已被替换，请重新观察。');
  if (entry.role !== roleOf(element) || entry.name !== nameOf(element)) return fail('BROWSER_ELEMENT_STALE', '元素内容或语义已变化，请重新观察。');
  if (request.operation === 'verify-element') {
    if (isPassword(element) && (request.value !== undefined || request.wantValue || attributeName?.toLowerCase() === 'value')) return fail('BROWSER_PASSWORD_READ_BLOCKED', '不支持读取或比较密码值。');
    return { value: isPassword(element) ? undefined : 'value' in element ? String(element.value) : element.innerText, text: element.innerText || element.textContent || '', ...readState(element), visible: visible(element, true), attached: true, count: 1 };
  }
  if (request.operation === 'scroll-into-view') { if (!visible(element, true)) return fail('BROWSER_ELEMENT_HIDDEN', '元素已隐藏'); element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return { scrolled: true }; }
  if (!['file-node', 'file-check'].includes(request.operation) && !visible(element)) return fail(visible(element, true) ? 'BROWSER_ELEMENT_OFFSCREEN' : 'BROWSER_ELEMENT_HIDDEN', '元素已隐藏或移出当前视口。');
  if (element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return fail('BROWSER_ELEMENT_DISABLED', '该元素当前不可用。');
  if (request.operation === 'prepare-stable') return (async () => {
    const result = await engine.checkElementStates(element, ['visible', 'enabled', 'stable']);
    if (result === 'error:notconnected') return fail('BROWSER_ELEMENT_STALE', '原元素已被替换，请重新定位。');
    if (result?.missingState) return fail(({ stable: 'BROWSER_ELEMENT_UNSTABLE', visible: 'BROWSER_ELEMENT_HIDDEN', enabled: 'BROWSER_ELEMENT_DISABLED' })[result.missingState] || 'BROWSER_ELEMENT_UNSTABLE', '元素状态尚未稳定');
    return pageOperationBody({ ...request, operation: 'prepare' }, createLocatorRuntime);
  })();
  if (request.operation === 'file-node' || request.operation === 'file-check') {
    if (element.tagName !== 'INPUT' || element.type !== 'file') return fail('BROWSER_FILE_INPUT_REQUIRED', '上传需要当前观察中的文件输入框。');
    if (element.webkitdirectory || element.hasAttribute('webkitdirectory') || element.hasAttribute('directory')) return fail('BROWSER_DIRECTORY_UPLOAD_UNSUPPORTED', '当前不支持目录上传。');
    if (request.fileCount > 1 && !element.multiple) return fail('BROWSER_MULTIPLE_FILES_UNSUPPORTED', '该输入框只能选择一个文件。');
    return request.operation === 'file-node' ? element : { valid: true };
  }
  if (request.operation === 'select') {
    if (element.tagName !== 'SELECT') return fail('BROWSER_SELECT_REQUIRED', '选择操作需要原生下拉框。');
    if (!element.multiple && request.values.length !== 1) return fail('BROWSER_INVALID_SELECTION', '单选下拉框必须选择一个值。');
    const options = Array.from(element.options);
    const selected = request.values.map(value => options.find(option => option.value === value));
    if (selected.some(option => !option || option.disabled || option.closest('optgroup[disabled]'))) return fail('BROWSER_OPTION_UNAVAILABLE', '选项不存在或当前不可用。');
    for (const option of options) option.selected = selected.includes(option);
    // Native select state with DOM events, deliberately not described as trusted input.
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { selectedValues: Array.from(element.selectedOptions, option => option.value), inputMode: 'dom-events' };
  }
  const editable = element.tagName === 'TEXTAREA' || element.isContentEditable || (element.tagName === 'INPUT' && /^(text|search|email|tel|url|password|number)$/.test(element.type));
  if (request.kind === 'fill' && (!editable || element.readOnly)) return fail('BROWSER_ELEMENT_NOT_EDITABLE', '填写操作需要可编辑的文本输入框。');
  if (request.operation === 'focused') {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active !== element && !element.contains(active)) return fail('BROWSER_FOCUS_CHANGED', '输入焦点已变化，本次未发送按键。');
    return { valid: true };
  }
  if (request.operation === 'focus') { element.focus({ preventScroll: true }); return { focused: true }; }
  const rect = element.getBoundingClientRect(), left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right), top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
  const points = request.x !== undefined ? [[request.x, request.y]] : [[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75]].map(([px, py]) => [left + (right - left) * px, top + (bottom - top) * py]);
  for (const [x, y] of points) {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) { const deeper = hit.shadowRoot.elementFromPoint(x, y); if (!deeper || deeper === hit) break; hit = deeper; }
    let candidate = hit;
    while (candidate) { if (candidate === element) return { x, y }; candidate = candidate.parentElement || candidate.getRootNode()?.host; }
  }
  return fail('BROWSER_ELEMENT_OBSCURED', '目标被其他元素遮挡，本次未发送输入。');
}

// Only trusted module source is assembled here. The adapter serializes this
// closed function; no require/module/global host dependency reaches the page.
const pageOperation = new Function('return function pageOperation(request) { const createLocatorRuntime = ' + createLocatorRuntime.toString() + '; return (' + pageOperationBody.toString() + ')(request, createLocatorRuntime); };')();

module.exports = { pageOperation };
