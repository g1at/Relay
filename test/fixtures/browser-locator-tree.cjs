'use strict';

// A deterministic DOM-shaped fixture for our composition/state algorithms.
// It does not substitute for native tests of Playwright's selector engine.
function fixture() {
  const document = { nodeType: 9, children: [], title: 'Locator fixture', readyState: 'complete', textContent: '' };
  document.documentElement = document;
  const descendants = (root, shadow = true) => {
    const result = [];
    for (const child of root.children || []) {
      result.push(child, ...descendants(child, shadow));
      if (shadow && child.shadowRoot) result.push(...descendants(child.shadowRoot, shadow));
    }
    return result;
  };
  const css = (element, selector) => selector.split(',').some(raw => {
    const part = raw.trim();
    if (part === '*') return true;
    if (part === ':disabled') return !!element.disabled;
    if (part === '[inert]') return element.hasAttribute('inert');
    if (part[0] === '#') return element.id === part.slice(1);
    if (part[0] === '.') return (element.getAttribute('class') || '').split(' ').includes(part.slice(1));
    if (part === '[contenteditable]') return element.isContentEditable;
    return element.tagName.toLowerCase() === part.toLowerCase();
  });
  document.querySelectorAll = selector => descendants(document, false).filter(element => css(element, selector));
  document.getElementById = id => descendants(document, false).find(element => element.id === id);
  const element = (id, role, text = '', options = {}, parent = document) => {
    const attributes = { id, ...options.attributes };
    const node = { nodeType: 1, id, role, name: options.name ?? text, textContent: text, innerText: text, tagName: (options.tag || 'div').toUpperCase(),
      ownerDocument: document, parentNode: parent, parentElement: parent.nodeType === 1 ? parent : null, children: [], isConnected: true,
      disabled: !!options.disabled, readOnly: !!options.readOnly, isContentEditable: !!options.editable,
      style: { display: 'block', visibility: options.hidden ? 'hidden' : 'visible', opacity: '1' },
      getAttribute: name => Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null,
      hasAttribute: name => Object.prototype.hasOwnProperty.call(attributes, name),
      setAttribute: (name, value) => { attributes[name] = String(value); },
      getRootNode() { let root = this; while (root.parentNode) root = root.parentNode; return root; },
      compareDocumentPosition(other) { if (this.getRootNode() !== other.getRootNode()) return 1; const all = descendants(document); return all.indexOf(this) < all.indexOf(other) ? 4 : 2; },
      matches(selector) { return css(this, selector); },
      closest(selector) { let node = this; while (node) { if (node.nodeType === 1 && css(node, selector)) return node; node = node.parentElement; } return null; },
      contains(other) { return this === other || descendants(this).includes(other); },
      querySelectorAll(selector) { return descendants(this, false).filter(node => css(node, selector)); },
      checkVisibility(options = {}) { return this.style.visibility !== 'hidden' && this.style.display !== 'none' && (!options.checkOpacity || this.style.opacity !== '0'); },
      getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 }),
      focus() { document.activeElement = this; }, scrollIntoView() {},
      ...options.properties,
    };
    if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') { node.type = options.type || 'text'; node.value = options.value || ''; }
    if (node.type === 'checkbox' || node.type === 'radio') node.checked = !!options.checked;
    parent.children.push(node);
    return node;
  };
  const engine = {
    parseSelector(selector) { return { parts: selector.split(' >> ').map(part => { const split = part.indexOf('='); return { name: part.slice(0, split), body: part.slice(split + 1) }; }) }; },
    querySelectorAll(parsed, root) {
      let scopes = [root];
      for (const part of parsed.parts) {
        scopes = scopes.flatMap(scope => descendants(scope).filter(node => {
          if (part.name === 'css') return css(node, part.body);
          if (part.name === 'internal:role') { const [role, encoded] = part.body.split('[name='); return node.role === role && (!encoded || literalMatch(node.name, encoded.slice(0, -1))); }
          if (part.name === 'internal:text') return literalMatch(node.textContent, part.body);
          if (part.name === 'internal:label') return literalMatch(node.name, part.body);
          if (part.name === 'internal:attr' || part.name === 'internal:testid') { const match = /^\[([^=]+)=(.*)\]$/.exec(part.body); return literalMatch(node.getAttribute(match[1]), match[2]); }
          throw Error('Fixture does not implement selector engine ' + part.name);
        }));
      }
      return scopes;
    },
    utils: { getAriaRole: node => node.role, getElementAccessibleNameText: node => node.name,
      elementText: (_cache, node) => ({ full: node.textContent }) },
    elementState(node, state) {
      if (!node.isConnected) return { matches: false, received: 'error:notconnected' };
      if (state === 'enabled') return { matches: !node.disabled && node.getAttribute('aria-disabled') !== 'true' };
      if (state === 'editable') return { matches: !node.disabled && !node.readOnly };
      if (state === 'visible') return { matches: node.checkVisibility() };
      throw Error('Unexpected state ' + state);
    },
    async checkElementStates(node, states) { return engine.stableResult; },
  };
  function literalMatch(value, encoded) { const exact = encoded.at(-1) === 's', expected = JSON.parse(encoded.slice(0, -1)); return exact ? String(value ?? '') === expected : String(value ?? '').toLowerCase().includes(expected.toLowerCase()); }
  document.elementFromPoint = () => document.hit || descendants(document).at(-1);
  const environment = { document, engine, visible: node => node.checkVisibility(), nameOf: node => node.name, roleOf: node => node.role };
  return { document, element, engine, environment, descendants };
}

module.exports = { fixture };
