// The renderer and search worker share the same saved-message contract.
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./vendor/marked.umd') : root.marked,
    node ? require('./assistant-output') : root.RelayAssistantOutput,
    node ? require('./supplement-timeline') : root.RelaySupplementTimeline,
    node ? require('./task-continuity') : root.RelayTaskContinuity);
  if (node) module.exports = api;
  if (root) root.RelayHistorySearchText = api;
})(typeof window === 'object' ? window : null, function (Marked, Output, Timeline, Continuity) {
  'use strict';
  // Own lexer: UI extensions/renderers must not change the worker's projection.
  const markdown = new Marked.Marked({ gfm: true, breaks: true });
  const string = value => value == null ? '' : String(value);
  const normalize = value => string(value).replace(/\s+/gu, ' ').trim().toLowerCase();
  const oldNotices = new Set([
    '（任务已完成，但刷新前的最终回复没有保存在可恢复的本地事件中。请在任务中心查看详情或重新执行。）',
    '（任务已结束，但未取得可恢复的最终回复。请在任务中心查看详情或重新执行。）',
  ]);

  function savedAssistant(turn) {
    let text;
    if (turn?.output && typeof turn.output === 'object' && Object.hasOwn(turn.output, 'final')) {
      text = turn.output.status === 'complete' && typeof turn.output.final === 'string' ? turn.output.final : '';
    } else if (!turn?.output && Array.isArray(turn?.chat) && turn.chat.length) text = '';
    else text = string(turn?.assistant);
    return oldNotices.has(text) ? '（任务已结束，但未取得可恢复的最终回复。可以重新发送请求。）' : text;
  }

  function fieldsForTurn(turn, kind = 'chat') {
    const fields = [];
    const add = (side, text, messageKey) => {
      text = string(text);
      if (side === 'assistant') text = Output.splitProtocol(text).text;
      if (text) fields.push({ side, text, messageKey });
    };
    if (kind === 'create') { add('prompt', turn?.prompt, 'user'); return fields; }
    if (!Continuity.isResume(turn)) add('user', turn?.user, 'user');
    const inputs = Array.isArray(turn?.supplements) ? turn.supplements : [];
    if (inputs.some(input => Timeline.normalize(input?.presentation))) {
      for (const segment of Timeline.plan({ output: turn?.output, supplements: inputs })) {
        add('assistant', segment.displayText ?? segment.text, 'assistant:' + segment.key);
        if (segment.inputAfter) add('user', segment.inputAfter.text, 'supplement:' + segment.inputAfter.id);
      }
    } else {
      const seen = new Set();
      for (const input of inputs) {
        if (!input?.id || seen.has(input.id)) continue;
        seen.add(input.id); add('user', input.text, 'supplement:' + input.id);
      }
      add('assistant', savedAssistant(turn), 'assistant');
    }
    return fields;
  }

  // Text entities are decoded once, just as in a rendered Markdown text node.
  // Code and escaped raw HTML stay literal (Relay never interprets raw HTML).
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', ndash: '–', mdash: '—', hellip: '…',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
    bull: '•', middot: '·', times: '×', divide: '÷', laquo: '«', raquo: '»' };
  function decodeEntities(text) {
    return string(text).replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]*);/gi, (whole, entity) => {
      if (entity[0] !== '#') return entities[entity] ?? whole;
      const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : '\ufffd';
    });
  }
  function tokenText(tokens) {
    return (tokens || []).map(token => {
      switch (token.type) {
        case 'space': case 'br': case 'hr': return '\n';
        case 'code': return '\n' + string(token.text) + '\n';
        case 'codespan': case 'html': case 'escape': return string(token.text);
        case 'paragraph': case 'heading': case 'blockquote':
          return tokenText(token.tokens) + '\n';
        case 'list': return token.items.map(item => tokenText(item.tokens)).join('\n') + '\n';
        case 'table': return [token.header, ...token.rows]
          .map(row => row.map(cell => tokenText(cell.tokens)).join('\t')).join('\n') + '\n';
        case 'def': return '';
        default: return token.tokens ? tokenText(token.tokens) : decodeEntities(token.text);
      }
    }).join('');
  }
  function displayText(value, { markdown: isMarkdown = false } = {}) {
    const source = string(value).replace(/[\x00\x01]/g, '');
    if (!isMarkdown) return source;
    try {
      // Match renderMarkdown/streamMarkdownRenderer's fence correction.
      return tokenText(markdown.lexer(source.replace(/([^\n`])(```+)/g, '$1\n$2'))).trim();
    } catch (_) { return source; }
  }

  // A normalized match keeps offsets into the original display text, including
  // repeated whitespace and Unicode lowercase expansions (for example İ).
  function matchRange(value, query) {
    const source = string(value), needle = normalize(query);
    if (!needle) return null;
    const index = normalize(source).indexOf(needle);
    if (index < 0) return null;
    let offset = 0, normalizedOffset = 0, whitespaceStart = -1, whitespaceEnd = -1, start;
    const consume = (from, to, length) => {
      if (start == null && index < normalizedOffset + length) start = from;
      normalizedOffset += length;
      return normalizedOffset >= index + needle.length ? { start, end: to } : null;
    };
    for (const character of source) {
      const end = offset + character.length;
      if (/\s/u.test(character)) {
        if (whitespaceStart < 0) whitespaceStart = offset;
        whitespaceEnd = end;
      } else {
        if (normalizedOffset && whitespaceStart >= 0) {
          const range = consume(whitespaceStart, whitespaceEnd, 1);
          if (range) return range;
        }
        whitespaceStart = -1;
        const range = consume(offset, end, character.toLowerCase().length);
        if (range) return range;
      }
      offset = end;
    }
    return null;
  }
  function snippet(value, query) {
    const source = string(value).replace(/[\x00\x01]/g, ''), range = matchRange(source, query);
    if (!range) return null;
    const start = Math.max(0, range.start - 30), end = Math.min(source.length, range.end + 30);
    const excerpt = source.slice(start, end);
    let cursor = 0, highlighted = '', next;
    while ((next = matchRange(excerpt.slice(cursor), query))) {
      highlighted += excerpt.slice(cursor, cursor + next.start) + '\x00'
        + excerpt.slice(cursor + next.start, cursor + next.end) + '\x01';
      cursor += next.end;
    }
    return (start ? '…' : '') + highlighted + excerpt.slice(cursor) + (end < source.length ? '…' : '');
  }
  return Object.freeze({ savedAssistant, fieldsForTurn, normalize, displayText, matchRange, snippet });
});
