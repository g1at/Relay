// Presentation boundaries for in-turn user input. The canonical assistant
// transcript stays intact; these ranges only determine where it is displayed.
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./assistant-output') : root.RelayAssistantOutput);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelaySupplementTimeline = api;
})(typeof window === 'object' ? window : null, function (Output) {
  'use strict';

  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        || value.version !== 1 || !Number.isSafeInteger(value.order) || value.order < 0
        || !Number.isSafeInteger(value.textLength) || value.textLength < 0 || value.textLength > 100000000
        || value.messageId !== null && (typeof value.messageId !== 'string'
          || !value.messageId || value.messageId.length > 200 || /[\0\r\n]/.test(value.messageId))) return null;
    return { version: 1, order: value.order, messageId: value.messageId, textLength: value.textLength };
  }

  function capture(output) {
    const message = output && Array.isArray(output.messages) && output.messages.findLast(item => !item.parent
      && Number(item.contextEpoch || 0) === Number(output.contextEpoch || 0));
    return normalize({ version: 1, order: Number(output && output.eventOrder || 0),
      messageId: message && message.id || null, textLength: message ? Output.textFor(message).length : 0 });
  }

  function fencedRanges(text) {
    const ranges = [];
    let offset = 0, open = null;
    for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
      const line = match[0];
      if (!line) continue;
      const content = line.replace(/[\r\n]+$/, '');
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
      if (marker) {
        if (open) {
          if (marker[1][0] === open.marker[0] && marker[1].length >= open.marker.length && /^\s*$/.test(marker[2])) {
            ranges.push({ ...open, closeStart: offset, closeEnd: offset + line.length, closed: true });
            open = null;
          }
        } else if (marker[1][0] !== '`' || !marker[2].includes('`')) {
          open = { start: offset, contentStart: offset + line.length, marker: marker[1], opener: content };
        }
      }
      offset += line.length;
    }
    if (open) ranges.push({ ...open, closeStart: text.length, closeEnd: text.length, closed: false });
    return ranges;
  }

  // Independent Markdown bodies need their own opening/closing fence. Only
  // display text gains those delimiters; stored/copy text is never rewritten.
  function fencedDisplay(text, ranges, start, end) {
    let from = start, to = end, prefix = '', suffix = '';
    const left = ranges.find(range => start > range.start && start < range.closeEnd);
    if (left) {
      if (left.closed && start >= left.closeStart) from = Math.min(end, left.closeEnd);
      else { from = Math.min(end, Math.max(start, left.contentStart)); prefix = left.opener + '\n'; }
    }
    const right = ranges.find(range => end > range.start && end < range.closeEnd);
    if (right) {
      if (end < right.contentStart) to = Math.max(from, right.start);
      else {
        to = Math.max(from, Math.min(end, right.closeStart));
        suffix = (text.slice(from, to).endsWith('\n') ? '' : '\n') + right.marker;
      }
    }
    if (from >= to) return '';
    return prefix + text.slice(from, to) + suffix;
  }

  // Examples: [work, input A, work, input B, answer] becomes three segments:
  // start/inputAfter=A, after:A/inputAfter=B, after:B/inputAfter=null.
  // Keys do not change when another input arrives, so views can reuse their DOM.
  function plan({ output, activityItems = [], supplements = [] } = {}) {
    const seen = new Set();
    const inputs = (Array.isArray(supplements) ? supplements : []).filter(input => {
      if (!input || typeof input.id !== 'string' || !input.id || seen.has(input.id)) return false;
      seen.add(input.id); return true;
    });
    const segments = Array.from({ length: inputs.length + 1 }, (_, index) => ({
      key: index ? 'after:' + inputs[index - 1].id : 'start', items: [], text: '', displayText: '',
      inputAfter: inputs[index] || null,
      segment: index === inputs.length ? 'current' : 'previous',
      isLatest: index === inputs.length, isPrevious: index < inputs.length,
    }));
    let lastOrder = 0;
    const boundaries = inputs.map(input => {
      const marker = normalize(input.presentation) || { order: lastOrder, messageId: null, textLength: 0 };
      lastOrder = Math.max(lastOrder, marker.order);
      return { ...marker, order: lastOrder };
    });
    // Several activity entries may share one event, with fractional sub-orders.
    const before = (order, marker) => !Number.isFinite(order) || Math.floor(order) <= marker.order;
    const bucket = order => {
      const index = boundaries.findIndex(marker => before(order, marker));
      return index < 0 ? inputs.length : index;
    };
    const messages = output && Array.isArray(output.messages) ? output.messages : [];
    const byId = new Map(messages.filter(message => !message.parent).map(message => [message.id, message]));
    const roots = new Map();
    for (const message of messages) {
      if (message.parent) continue;
      let offset = 0;
      for (const block of message.blocks || []) {
        if (block.type !== 'text') continue;
        roots.set('output::' + message.id + ':' + block.index, { message, block, offset });
        offset += String(block.text || '').length;
      }
    }
    function split(text, message, offset = 0, order = message && message.order) {
      const parts = [];
      let start = 0;
      for (let index = 0; index < boundaries.length; index += 1) {
        const marker = boundaries[index];
        const requested = message && marker.messageId === message.id ? marker.textLength - offset
          : before(order, marker) ? text.length : 0;
        const end = Math.max(start, Math.min(text.length, Math.max(0, requested)));
        if (end > start) parts.push({ index, text: text.slice(start, end), start, end });
        start = end;
      }
      if (start < text.length) parts.push({ index: inputs.length, text: text.slice(start), start, end: text.length });
      return parts;
    }

    // A send-position boundary only divides the process; it cannot promote a
    // provisional SDK message into a final answer on either side of the input.
    const confirmed = output && output.status === 'complete';
    const answers = !confirmed ? [] : Array.isArray(output.answers) && output.answers.length ? output.answers
      : [{ text: output.final || '', messageId: output.finalMessageId }];
    const visibleIds = new Set(answers.filter(answer => answer.text).map(answer => answer.messageId).filter(Boolean));

    for (const item of Array.isArray(activityItems) ? activityItems : []) {
      if (!item) continue;
      const source = item.outputOwned && roots.get(item.id);
      if (source && visibleIds.has(source.message.id)) continue;
      if (!source || item.type !== 'narration') {
        segments[bucket(item.order)].items.push(item);
        continue;
      }
      const parts = split(String(item.result || ''), source.message, source.offset,
        source.block.order == null ? source.message.order : source.block.order);
      const safeText = String(item.displayText == null ? Output.visibleText(item.result || '', item.status !== 'running') : item.displayText);
      const ranges = parts.length > 1 ? fencedRanges(safeText) : [];
      for (const part of parts) {
        const settled = item.status !== 'running' || part.index < inputs.length;
        const whole = part.text === String(item.result || '');
        if (whole && (!settled || item.status !== 'running')) {
          // Completed narration can be large. Keep its parsed/display text and
          // identity when a boundary did not actually split it.
          segments[part.index].items.push(item);
          continue;
        }
        segments[part.index].items.push({ ...item,
          id: inputs.length ? item.id + ':timeline:' + segments[part.index].key : item.id,
          result: part.text, displayText: whole ? item.displayText
            : fencedDisplay(safeText, ranges, Math.min(part.start, safeText.length), Math.min(part.end, safeText.length)),
          status: settled && item.status === 'running' ? 'success' : item.status,
        });
      }
    }
    for (const answer of answers) {
      const visibleText = String(answer.text || '');
      if (!visibleText) continue;
      const visibleMessage = answer.messageId && byId.get(answer.messageId);
      const append = (index, text, displayText) => {
        const segment = segments[index], separator = segment.text ? '\n\n' : '';
        segment.text += separator + text;
        segment.displayText += separator + displayText;
      };
      if (visibleMessage) {
        const parts = split(visibleText, visibleMessage);
        const ranges = parts.length > 1 ? fencedRanges(visibleText) : [];
        for (const part of parts) {
          append(part.index, part.text, fencedDisplay(visibleText, ranges, part.start, part.end));
        }
      } else {
        // A result can contain a new final summary not present in streamed
        // message blocks. Do not guess how to splice it into earlier output.
        append(answer === answers[answers.length - 1] || !Number.isFinite(answer.order)
          ? segments.length - 1 : bucket(answer.order), visibleText, visibleText);
      }
    }
    return segments;
  }

  return { capture, normalize, plan };
});
