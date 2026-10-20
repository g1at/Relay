'use strict';

// Some model endpoints accept anyOf but misdiagnose a referenced oneOf as
// recursive. Only rewrite a oneOf when its object branches have a shared,
// required discriminator with pairwise-disjoint literal values. In that case
// no input can match two branches, so oneOf and anyOf are exactly equivalent.
// The original MCP server still validates every call using its own schema.
const MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const CHILD_KEYS = new Set(['items', 'additionalProperties', 'additionalItems', 'unevaluatedProperties',
  'unevaluatedItems', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'contentSchema']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasReference = value => ['$ref', '$dynamicRef', '$recursiveRef'].some(key => Object.hasOwn(value, key));
const primitiveKey = value => value === null || ['string', 'boolean'].includes(typeof value)
  || (typeof value === 'number' && Number.isFinite(value)) ? JSON.stringify(value) : undefined;

function discriminatorValues(schema) {
  // Older JSON Schema drafts ignore siblings of $ref. A nearby const/enum
  // therefore cannot prove that a referenced discriminator is disjoint.
  if (!isRecord(schema) || hasReference(schema) || Object.hasOwn(schema, '$schema')) return null;
  const values = Object.hasOwn(schema, 'const') ? [schema.const] : schema.enum;
  if (!Array.isArray(values) || !values.length) return null;
  const keys = values.map(primitiveKey);
  return keys.every(key => key !== undefined) ? keys : null;
}

function hasDisjointDiscriminator(branches, resolve = value => value) {
  if (Array.isArray(branches)) branches = branches.map(resolve);
  if (!Array.isArray(branches) || branches.length < 2 || branches.some(branch =>
    !isRecord(branch) || hasReference(branch) || Object.hasOwn(branch, '$schema') || branch.type !== 'object' || !Array.isArray(branch.required) || !isRecord(branch.properties))) return false;
  for (const name of branches[0].required) {
    if (typeof name !== 'string') continue;
    const seen = new Set();
    let disjoint = true;
    for (const branch of branches) {
      if (!branch.required.includes(name) || !Object.hasOwn(branch.properties, name)) { disjoint = false; break; }
      const values = discriminatorValues(branch.properties[name]);
      if (!values || values.some(value => seen.has(value))) { disjoint = false; break; }
      for (const value of values) seen.add(value);
    }
    if (disjoint) return true;
  }
  return false;
}

function projectToolInputSchema(schema) {
  // const was introduced in draft-06. Unknown or older dialects may ignore it,
  // so their apparent literal tags are not sufficient proof of disjointness.
  if (isRecord(schema) && typeof schema.$schema === 'string'
      && !/^https?:\/\/json-schema\.org\/(?:draft-(?:06|07)\/schema|draft\/(?:2019-09|2020-12)\/schema)#?$/.test(schema.$schema)) return schema;
  let visited = 0;
  const active = new WeakSet();
  function resolveBranch(branch) {
    const refs = new Set();
    while (isRecord(branch) && typeof branch.$ref === 'string') {
      // Only root definitions have an unambiguous local base here. Scope-changing
      // IDs, external references and cycles are left to the original schema.
      if (Object.hasOwn(branch, '$id') || Object.hasOwn(branch, '$schema') || refs.has(branch.$ref) || refs.size >= 64) return null;
      refs.add(branch.$ref);
      const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(branch.$ref);
      if (!match) return null;
      const name = match[2].replace(/~1/g, '/').replace(/~0/g, '~');
      const defs = schema[match[1]];
      if (!isRecord(defs) || !Object.hasOwn(defs, name)) return null;
      branch = defs[name];
    }
    return isRecord(branch) && !Object.hasOwn(branch, '$id') && !Object.hasOwn(branch, '$schema') ? branch : null;
  }
  function visit(node, depth, rootScope = true) {
    if (!isRecord(node)) return node;
    // Embedded resources may switch dialects independently. Preserve their
    // entire schema and decline using their literal tags as proof outside it.
    if (depth > 0 && Object.hasOwn(node, '$schema')) return node;
    // Limits protect the host from malformed or excessive advertisements. Abort
    // the whole projection instead of returning a partially rewritten schema.
    if (++visited > 50000 || depth > 64 || active.has(node)) throw new Error('MCP_SCHEMA_PROJECTION_LIMIT');
    active.add(node);
    rootScope &&= depth === 0 || !Object.hasOwn(node, '$id');
    let changed = false;
    const entries = Object.entries(node).map(([key, value]) => {
      let projected = value;
      if (MAP_KEYS.has(key) && isRecord(value)) {
        const nested = Object.entries(value).map(([name, child]) => [name, visit(child, depth + 1, rootScope)]);
        if (nested.some(([name, child]) => child !== value[name])) projected = Object.fromEntries(nested);
      } else if ((ARRAY_KEYS.has(key) || key === 'items') && Array.isArray(value)) {
        const nested = value.map(child => visit(child, depth + 1, rootScope));
        if (nested.some((child, index) => child !== value[index])) projected = nested;
      } else if (CHILD_KEYS.has(key)) projected = visit(value, depth + 1, rootScope);
      // Annotation examples, enum/default/const data, and unknown extension
      // keywords are opaque; objects inside those are not schemas.
      changed ||= projected !== value;
      return [key, projected];
    });
    active.delete(node);
    const result = changed ? Object.fromEntries(entries) : node;
    if (Object.hasOwn(result, 'oneOf') && !Object.hasOwn(result, 'anyOf') && hasDisjointDiscriminator(result.oneOf, rootScope ? resolveBranch : value => value)) {
      return Object.fromEntries(Object.entries(result).map(([key, value]) => [key === 'oneOf' ? 'anyOf' : key, value]));
    }
    return result;
  }
  try { return visit(schema, 0); } catch (_) { return schema; }
}

function projectMcpToolsList(message, { alwaysLoad = false } = {}) {
  if (!isRecord(message?.result) || !Array.isArray(message.result.tools)) return message;
  let changed = false;
  const tools = message.result.tools.map(tool => {
    if (!isRecord(tool)) return tool;
    const inputSchema = projectToolInputSchema(tool.inputSchema);
    const markAlwaysLoad = alwaysLoad && tool._meta?.['anthropic/alwaysLoad'] !== true;
    if (inputSchema === tool.inputSchema && !markAlwaysLoad) return tool;
    changed = true;
    return { ...tool, ...(inputSchema !== tool.inputSchema ? { inputSchema } : {}),
      ...(markAlwaysLoad ? { _meta: { ...tool._meta, 'anthropic/alwaysLoad': true } } : {}) };
  });
  return changed ? { ...message, result: { ...message.result, tools } } : message;
}

module.exports = { hasDisjointDiscriminator, projectToolInputSchema, projectMcpToolsList };
