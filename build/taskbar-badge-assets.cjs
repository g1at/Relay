'use strict';

// Frames are drawn separately at every supported physical taskbar size. Keep
// the runtime selector and generated artwork in sync; 256px is the ICO preview.
const { TASKBAR_FRAME_SIZES } = require('../src/main/app/taskbar-completion-badge');
const BADGE_SIZES = Object.freeze([...TASKBAR_FRAME_SIZES, 256]);
const BADGES = Object.freeze([
  ...Array.from({ length: 9 }, (_, index) => ({ name: String(index + 1), label: String(index + 1) })),
  { name: '9-plus', label: '9+' },
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function encodeBadgeIco(frames) {
  if (!Array.isArray(frames) || frames.length !== BADGE_SIZES.length) throw Error('Missing taskbar badge DPI frames');
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const size = BADGE_SIZES[index];
    if (!Buffer.isBuffer(frame) || frame.length < 24 || !frame.subarray(0, 8).equals(PNG_SIGNATURE)
        || frame.readUInt32BE(16) !== size || frame.readUInt32BE(20) !== size) throw Error(`Invalid ${size}px taskbar badge frame`);
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  return Buffer.concat([header, ...frames]);
}

module.exports = { BADGE_SIZES, BADGES, encodeBadgeIco };
