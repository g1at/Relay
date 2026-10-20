'use strict';

// This function is deliberately self-contained: its source is embedded in the
// isolated-world page operation. User input is data, never a JavaScript program.
function createLocatorRuntime(environment = {}) {
  const limits = { role: 100, name: 1000, text: 2000, label: 1000, placeholder: 1000, testId: 500, css: 2000 };
  const baseKeys = Object.keys(limits), atomKeys = [...baseKeys, 'exact', 'nth'];
  const stepKeys = [...atomKeys, 'has', 'hasNot', 'and', 'or', 'hasText', 'hasNotText', 'visible'];
  const problem = (message, code = 'BROWSER_INVALID_LOCATOR') => { throw Object.assign(new Error(message), { code }); };
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const validate = locator => {
    let nodes = 0;
    const seen = new Set();
    const check = (value, kind) => {
      if (++nodes > 64) problem('定位条件最多包含 64 个节点');
      if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) problem('定位条件必须为无循环的对象');
      seen.add(value);
      const allowed = kind === 'atom' ? atomKeys : kind === 'step' ? stepKeys : [...stepKeys, 'within', 'chain'];
      if (Object.keys(value).some(key => !allowed.includes(key))) problem('定位条件包含不支持的字段');
      if (!baseKeys.some(key => typeof value[key] === 'string' && value[key].length)) problem('每个定位步骤都需要基本定位条件');
      for (const [key, max] of Object.entries(limits)) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > max)) problem('定位条件的文本无效');
      if (value.role !== undefined && !/^[a-z][a-z0-9-]*$/.test(value.role)) problem('角色名无效');
      if (value.exact !== undefined && typeof value.exact !== 'boolean') problem('exact 必须为布尔值');
      if (value.nth !== undefined && (!Number.isInteger(value.nth) || value.nth < 0 || value.nth > 10000)) problem('nth 必须为 0 到 10000 的整数');
      if (value.visible !== undefined && typeof value.visible !== 'boolean') problem('visible 必须为布尔值');
      for (const key of ['hasText', 'hasNotText']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].length || value[key].length > 2000)) problem('文本过滤条件无效');
      for (const key of ['has', 'hasNot']) if (value[key] !== undefined) check(value[key], 'atom');
      for (const key of ['and', 'or', 'chain']) if (value[key] !== undefined) {
        if (!Array.isArray(value[key]) || value[key].length < 1 || value[key].length > 6) problem(key + ' 必须包含 1 到 6 个步骤');
        for (const entry of value[key]) check(entry, key === 'chain' ? 'step' : 'atom');
      }
      if (value.within !== undefined) check(value.within, 'step');
      seen.delete(value);
    };
    check(locator, 'locator');
    return locator;
  };
  const find = (locator, root = environment.document) => {
    validate(locator);
    const { engine, document, visible, nameOf, roleOf } = environment;
    if (!engine || !document || !root) problem('页面定位引擎尚未就绪', 'BROWSER_DOCUMENT_NOT_READY');
    let examined = 0;
    const spend = count => { examined += count; if (examined > 100000) problem('定位范围过大，请使用 within 收窄范围', 'BROWSER_LOCATOR_LIMIT'); };
    const parent = node => node.parentElement || node.getRootNode?.()?.host;
    const inScope = (element, scope, descendants) => {
      if (!element || element.nodeType !== 1 || element.ownerDocument !== document || !element.isConnected || (descendants && element === scope)) return false;
      if (scope.nodeType === 9) return scope === document;
      for (let node = element; node; node = parent(node)) if (node === scope || node.getRootNode?.() === scope) return true;
      return false;
    };
    let shadowOrder;
    const order = elements => {
      const unique = [...new Set(elements)];
      spend(unique.length);
      return unique.sort((a, b) => {
        if (a === b) return 0;
        const relation = a.compareDocumentPosition(b);
        if (!(relation & 1)) return relation & 4 ? -1 : relation & 2 ? 1 : 0;
        // Across shadow roots compareDocumentPosition is disconnected. Use a
        // deterministic host/descendant traversal, without entering iframes.
        if (!shadowOrder) {
          shadowOrder = new Map();
          const visit = node => {
            if (node.nodeType === 1) { spend(1); shadowOrder.set(node, shadowOrder.size); }
            for (const child of node.children || []) visit(child);
            if (node.shadowRoot) visit(node.shadowRoot);
          };
          visit(document);
        }
        return (shadowOrder.get(a) ?? Infinity) - (shadowOrder.get(b) ?? Infinity);
      });
    };
    const textOf = element => normalize(engine.utils?.elementText ? engine.utils.elementText(new Map(), element).full : element.innerText || element.textContent);
    const atom = (value, scopes, descendants = false, useNth = true) => {
      const exact = value.exact !== false;
      const literal = text => JSON.stringify(text) + (exact ? 's' : 'i');
      const eq = (actual, expected) => exact ? normalize(actual) === normalize(expected) : normalize(actual).toLowerCase().includes(normalize(expected).toLowerCase());
      let selector = value.css ? 'css=' + value.css : value.role ? 'internal:role=' + value.role + (value.name ? '[name=' + literal(value.name) + ']' : '')
        : value.label ? 'internal:label=' + literal(value.label) : value.testId ? 'internal:testid=[data-testid=' + JSON.stringify(value.testId) + 's]'
          : value.placeholder ? 'internal:attr=[placeholder=' + literal(value.placeholder) + ']' : value.text ? 'internal:text=' + literal(value.text) : 'css=*';
      let parsed;
      try { parsed = engine.parseSelector(selector); }
      catch (error) { problem('定位选择器无效: ' + error.message); }
      // CSS is not an escape hatch into another selector engine or frame. Frame
      // access always goes through the adapter's authorized frameId world.
      if (value.css && parsed.parts.some(part => part.name !== 'css')) problem('CSS 定位不能切换选择器引擎或进入框架');
      let found = [];
      for (const scope of scopes) {
        const queried = engine.querySelectorAll(parsed, scope);
        spend(queried.length);
        found.push(...queried.filter(element => inScope(element, scope, descendants)));
      }
      found = order(found).filter(element => (!value.role || roleOf(element) === value.role)
        && (!value.name || eq(nameOf(element), value.name)) && (!value.text || eq(textOf(element), value.text))
        && (!value.label || (!value.css && !value.role) || eq(Array.from(element.labels || [], label => label.textContent).join(' ') || nameOf(element), value.label))
        && (!value.placeholder || eq(element.getAttribute('placeholder'), value.placeholder)) && (!value.testId || element.getAttribute('data-testid') === value.testId));
      return useNth && value.nth !== undefined ? found.slice(value.nth, value.nth + 1) : found;
    };
    const step = (value, scopes, descendants = false) => {
      let found = atom(value, scopes, descendants, false);
      for (const condition of value.and || []) { const matching = new Set(atom(condition, scopes, descendants)); found = found.filter(element => matching.has(element)); }
      for (const condition of value.or || []) found.push(...atom(condition, scopes, descendants));
      const containsText = (element, text) => textOf(element).toLowerCase().includes(normalize(text).toLowerCase());
      found = order(found).filter(element => (!value.has || atom(value.has, [element], true).length > 0)
        && (!value.hasNot || atom(value.hasNot, [element], true).length === 0)
        && (value.hasText === undefined || containsText(element, value.hasText))
        && (value.hasNotText === undefined || !containsText(element, value.hasNotText))
        && (value.visible === undefined || visible(element, true) === value.visible));
      return value.nth === undefined ? found : found.slice(value.nth, value.nth + 1);
    };
    const scopes = locator.within ? step(locator.within, [root]) : [root];
    let result = step(locator, scopes, !!locator.within);
    for (const condition of locator.chain || []) result = step(condition, result, true);
    return result;
  };
  return { validate, find };
}

function validateLocator(locator) { return createLocatorRuntime().validate(locator); }

function createLocatorSchema(z) {
  const fields = { role: z.string().min(1).max(100).optional(), name: z.string().max(1000).optional(), text: z.string().max(2000).optional(),
    label: z.string().max(1000).optional(), placeholder: z.string().max(1000).optional(), testId: z.string().max(500).optional(), css: z.string().max(2000).optional(),
    exact: z.boolean().optional(), nth: z.number().int().min(0).max(10000).optional() };
  const atom = z.object(fields).strict();
  const stepFields = { ...fields, has: atom.optional(), hasNot: atom.optional(), and: z.array(atom).min(1).max(6).optional(), or: z.array(atom).min(1).max(6).optional(),
    hasText: z.string().min(1).max(2000).optional(), hasNotText: z.string().min(1).max(2000).optional(), visible: z.boolean().optional() };
  const step = z.object(stepFields).strict();
  return z.object({ ...stepFields, within: step.optional(), chain: z.array(step).min(1).max(6).optional() }).strict().superRefine((value, context) => {
    try { validateLocator(value); } catch (error) { context.addIssue({ code: 'custom', message: error.message }); }
  });
}

module.exports = { createLocatorRuntime, validateLocator, createLocatorSchema };
