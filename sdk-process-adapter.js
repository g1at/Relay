'use strict';
const { EventEmitter } = require('node:events');
// SDK sees a bounded stderr-drained exit. Host watchdogs keep the actual child,
// pid and native lifecycle; this facade changes only the SDK exit notification.
function withDrainedExit(child, { graceMs = 500 } = {}) {
  if (!child || typeof child.on !== 'function' || typeof child.once !== 'function') return child;
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
