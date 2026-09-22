'use strict';

// MCP 1.30 form elicitation is a flat object of primitives (plus string enums),
// not arbitrary JSON Schema. Reject unknown constraints instead of silently
// stripping them or converting a server's form into AskUserQuestion.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const common = ['type', 'title', 'description', 'default'];
const FORMATS = new Set(['email', 'uri', 'date', 'date-time']);

function fail(message) { throw new Error(message); }
function keys(value, allowed) {
  if (!record(value)) fail('表单结构无效');
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key) || !allowed.includes(key)) fail(`暂不支持表单约束：${key}`);
  }
}
function text(value, label, max = 4000) {
  if (typeof value !== 'string' || value.length > max) fail(`${label}格式无效或过长`);
  return value;
}
function enumOptions(value, titled = false, titles) {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail('选择项数量无效');
  const result = value.map((option, index) => {
    if (titled) {
      keys(option, ['const', 'title']);
      return { value: text(option.const, '选项', 1000), label: text(option.title, '选项名称', 1000) };
    }
    return { value: text(option, '选项', 1000), label: titles ? text(titles[index], '选项名称', 1000) : option };
  });
  if (new Set(result.map(option => option.value)).size !== result.length) fail('表单包含重复选择项');
  return result;
}

function normalizeElicitationSchema(schema) {
  keys(schema, ['$schema', 'type', 'title', 'description', 'properties', 'required', 'additionalProperties']);
  if (schema.type !== 'object' || !record(schema.properties)) fail('暂不支持嵌套或非对象表单');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') fail('暂不支持额外字段的约束');
  const names = Object.keys(schema.properties);
  if (names.length > 40) fail('表单字段超过 40 项，请让工具拆分请求');
  const required = schema.required || [];
  if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !own(schema.properties, key))) fail('必填字段声明无效');
  const fields = names.map(name => {
    if (UNSAFE_KEYS.has(name) || !name.length || name.length > 200) fail('表单字段名称无效');
    const source = schema.properties[name];
    if (!record(source)) fail('表单字段结构无效');
    const kind = source.type;
    const allowed = kind === 'string' ? [...common, 'minLength', 'maxLength', 'format', 'enum', 'enumNames', 'oneOf']
      : kind === 'number' || kind === 'integer' ? [...common, 'minimum', 'maximum']
        : kind === 'boolean' ? common : kind === 'array' ? [...common, 'items', 'minItems', 'maxItems'] : [];
    if (!allowed.length) fail(`暂不支持字段类型：${String(kind)}`);
    keys(source, allowed);
    const field = { name, type: kind, label: source.title === undefined ? name : text(source.title, '字段名称', 1000),
      description: source.description === undefined ? '' : text(source.description, '字段说明'), required: required.includes(name) };
    if (kind === 'string') {
      if (source.enum !== undefined && source.oneOf !== undefined) fail('选择项声明冲突');
      if (source.enumNames !== undefined && (!Array.isArray(source.enumNames) || !Array.isArray(source.enum) || source.enumNames.length !== source.enum.length)) fail('选项名称与值不匹配');
      if (source.enum !== undefined) field.options = enumOptions(source.enum, false, source.enumNames);
      if (source.oneOf !== undefined) field.options = enumOptions(source.oneOf, true);
      if (source.format !== undefined) {
        if (!FORMATS.has(source.format)) fail(`暂不支持字段格式：${source.format}`);
        field.format = source.format;
      }
    }
    if (kind === 'array') {
      keys(source.items, ['type', 'enum', 'anyOf']);
      if (source.items.anyOf !== undefined) {
        if (source.items.enum !== undefined || source.items.type !== undefined) fail('多选结构存在冲突');
        field.options = enumOptions(source.items.anyOf, true);
      } else {
        if (source.items.type !== 'string') fail('多选只支持字符串');
        field.options = enumOptions(source.items.enum);
      }
    }
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (source[key] === undefined) continue;
      if (!Number.isFinite(source[key]) || (!['minimum', 'maximum'].includes(key) && (!Number.isSafeInteger(source[key]) || source[key] < 0))) fail(`${key}约束无效`);
      field[key] = source[key];
    }
    for (const [min, max] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems']]) {
      if (field[min] !== undefined && field[max] !== undefined && field[min] > field[max]) fail('表单上下限存在冲突');
    }
    if (own(source, 'default')) {
      validateField(field, source.default);
      field.default = Array.isArray(source.default) ? [...source.default] : source.default;
    }
    return field;
  });
  return { fields };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateField(field, value) {
  const error = reason => fail(`${field.label}：${reason}`);
  if (field.type === 'string') {
    if (typeof value !== 'string') error('请输入文本');
    const length = [...value].length;
    if (length > 32000 || (field.maxLength !== undefined && length > field.maxLength)) error('内容过长');
    if (field.minLength !== undefined && length < field.minLength) error(`至少输入 ${field.minLength} 个字符`);
    if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) error('请输入完整邮箱地址');
    if (field.format === 'uri') { try { new URL(value); } catch (_) { error('请输入绝对 URL'); } }
    if (field.format === 'date' && !validDate(value)) error('日期无效');
    if (field.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      || !validDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value)))) error('请输入包含时区的完整日期时间');
    if (field.options && !field.options.some(option => option.value === value)) error('请选择列表中的值');
  } else if (field.type === 'boolean') {
    if (typeof value !== 'boolean') error('请选择是或否');
  } else if (field.type === 'number' || field.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) error('请输入有效数字');
    if (field.type === 'integer' && !Number.isSafeInteger(value)) error('请输入安全范围内的整数');
    if (field.minimum !== undefined && value < field.minimum) error(`不得小于 ${field.minimum}`);
    if (field.maximum !== undefined && value > field.maximum) error(`不得大于 ${field.maximum}`);
  } else if (field.type === 'array') {
    if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !field.options.some(option => option.value === item))) error('请选择列表中的值');
    if (new Set(value).size !== value.length) error('选择项重复');
    if (field.minItems !== undefined && value.length < field.minItems) error(`至少选择 ${field.minItems} 项`);
    if (field.maxItems !== undefined && value.length > field.maxItems) error(`最多选择 ${field.maxItems} 项`);
  }
}

function validateElicitationContent(schema, content) {
  if (!record(content)) fail('回复必须是表单对象');
  const fields = schema.fields;
  for (const key of Object.keys(content)) {
    if (UNSAFE_KEYS.has(key) || !fields.some(field => field.name === key)) fail('回复包含未请求的字段');
  }
  const result = {};
  for (const field of fields) {
    if (!own(content, field.name)) {
      if (field.required) fail(`${field.label}：请填写此项`);
      continue;
    }
    validateField(field, content[field.name]);
    result[field.name] = Array.isArray(content[field.name]) ? [...content[field.name]] : content[field.name];
  }
  return result;
}

function normalizeElicitationUrl(value) {
  if (typeof value !== 'string' || value.length > 16000 || /[\u0000-\u0020]/.test(value)) fail('工具提供的网页地址无效');
  let url;
  try { url = new URL(value); } catch (_) { fail('工具提供的网页地址无效'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail('工具网页只支持 HTTPS 或本地回调地址');
  if (url.username || url.password) fail('网页地址不能包含用户名或密码');
  return url.href;
}

module.exports = { normalizeElicitationSchema, validateElicitationContent, normalizeElicitationUrl };
