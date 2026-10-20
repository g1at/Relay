'use strict';
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
// SDK sees a bounded stderr-drained exit. Host watchdogs keep the actual child,
// pid and native lifecycle; this facade changes only the SDK exit notification.
function withDrainedExit(child, { graceMs = 500, onStderr } = {}) {
  if (!child || typeof child.on !== 'function' || typeof child.once !== 'function') return child;
  // SDK custom spawns bypass its default stderr reader. Always drain this pipe:
  // a child writing diagnostics can otherwise block before producing a result
  // or reading an interrupt. Only decoder carry bytes are retained here.
  if (child.stderr && typeof child.stderr.on === 'function') {
    const stream = child.stderr, decoder = new StringDecoder('utf8');
    let flushed = false;
    const forward = text => {
      if (!text || typeof onStderr !== 'function') return;
      try {
        const result = onStderr(text);
        // Observers must not break pipe consumption, including async observers.
        if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      } catch (_) {}
    };
    const consume = chunk => forward(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    const flush = () => { if (!flushed) { flushed = true; forward(decoder.end()); } };
    stream.on('data', consume);
    stream.on('error', () => {});
    stream.once('end', flush);
    stream.once('close', () => { flush(); stream.off('data', consume); stream.off('end', flush); });
  }
  const events = new EventEmitter(); let ended = false, fired = false, code, signal, timer;
  const drained = () => !child.stderr || child.stderr.readableEnded || child.stderr.destroyed;
  const finish = () => {
    if (!ended || fired) return;
    fired = true; clearTimeout(timer); child.stderr?.off?.('end', finish); child.stderr?.off?.('close', finish);
    events.emit('exit', code, signal);
  };
  child.once('exit', (c, s) => { ended = true; code = c; signal = s; if (drained()) finish(); else { timer = setTimeout(finish, graceMs); timer.unref?.(); } });
  child.stderr?.once?.('end', finish); child.stderr?.once?.('close', finish);
  return new Proxy(child, { get(target, key) {
    if (['on', 'once', 'off', 'removeListener'].includes(key)) return (event, listener) => {
      const source = event === 'exit' ? events : target;
      return source[key](event, listener);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
module.exports = { withDrainedExit };
