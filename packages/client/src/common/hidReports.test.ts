// Run: node src/common/hidReports.test.ts   (Node 22.6+ strips the types itself)
import assert from 'node:assert/strict';
import { CODE_TO_KEY, VALID_KEY_IDS } from './keyScan.ts';
import {
  KEY_ID_TO_USAGE,
  KEYBOARD_DESCRIPTOR,
  KeyboardReportBuilder,
  MOUSE_DESCRIPTOR,
  MouseReportBuilder
} from './hidReports.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const key = (code: string) => CODE_TO_KEY[code];

// Every key the wire can carry has a HID usage, and no two keys share one.
for (const id of VALID_KEY_IDS) assert.ok(KEY_ID_TO_USAGE[id] !== undefined, `no usage for key id 0x${id.toString(16)}`);
const usages = Object.values(KEY_ID_TO_USAGE);
assert.equal(new Set(usages).size, usages.length, 'usages must be unique');

// Spot checks against the USB HID usage tables.
assert.equal(KEY_ID_TO_USAGE[key('KeyA')], 0x04);
assert.equal(KEY_ID_TO_USAGE[key('KeyZ')], 0x1d);
assert.equal(KEY_ID_TO_USAGE[key('Digit1')], 0x1e);
assert.equal(KEY_ID_TO_USAGE[key('Digit0')], 0x27);
assert.equal(KEY_ID_TO_USAGE[key('Escape')], 0x29);
assert.equal(KEY_ID_TO_USAGE[key('F1')], 0x3a);
assert.equal(KEY_ID_TO_USAGE[key('F12')], 0x45);
assert.equal(KEY_ID_TO_USAGE[key('ArrowRight')], 0x4f);
assert.equal(KEY_ID_TO_USAGE[key('Delete')], 0x4c);
assert.equal(KEY_ID_TO_USAGE[key('MetaLeft')], 0xe3);

// The combinations from the test matrix, as the report stream Windows would see them.
function sequence(codes: string[]): string[] {
  const kb = new KeyboardReportBuilder();
  const reports: string[] = [];
  for (const code of codes) {
    kb.press(key(code));
    reports.push(hex(kb.report()));
  }
  for (const code of [...codes].reverse()) {
    kb.release(key(code));
    reports.push(hex(kb.report()));
  }
  return reports;
}

// Ctrl + Shift + Esc: CTRL DOWN, SHIFT DOWN, ESC DOWN, then ESC UP, SHIFT UP, CTRL UP (spec 9/19)
assert.deepEqual(sequence(['ControlLeft', 'ShiftLeft', 'Escape']), [
  '0100000000000000',
  '0300000000000000',
  '0300290000000000',
  '0300000000000000',
  '0100000000000000',
  '0000000000000000'
]);
// Ctrl+C, Alt+Tab, Win+D, Alt+F4 all end with nothing held (no stuck key).
for (const combo of [['ControlLeft', 'KeyC'], ['AltLeft', 'Tab'], ['MetaLeft', 'KeyD'], ['AltLeft', 'F4'], ['ControlLeft', 'ShiftLeft', 'KeyS'], ['MetaLeft', 'KeyR'], ['ControlLeft', 'KeyV'], ['ControlLeft', 'KeyA'], ['ControlLeft', 'KeyF']]) {
  const reports = sequence(combo);
  assert.equal(reports.at(-1), '0000000000000000', combo.join('+'));
}
// Right-hand modifiers use the upper modifier bits.
const rk = new KeyboardReportBuilder();
rk.press(key('ControlRight'));
rk.press(key('AltRight'));
assert.equal(rk.report()[0], 0x50);

// Seventh simultaneous key = rollover error, like real hardware; Input Reset clears everything.
const roll = new KeyboardReportBuilder();
['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG'].forEach((c) => roll.press(key(c)));
assert.equal(hex(roll.report()), '0000010101010101');
roll.reset();
assert.equal(hex(roll.report()), '0000000000000000');
assert.equal(roll.press(0x7f), false); // unknown key id is refused, not guessed

// Mouse: buttons mask, little-endian absolute position, one-shot wheel with int8 wrap.
const mouse = new MouseReportBuilder();
mouse.setButton(0, true);
mouse.setButton(2, true);
mouse.moveAbs(32767, 16384);
mouse.scroll(-1, 1);
assert.equal(hex(mouse.report()), '05ff7f004000ff01'.slice(0, 2) + 'ff7f0040' + 'ff01');
assert.equal(hex(mouse.report()), '05' + 'ff7f0040' + '0000'); // wheel/pan cleared after one report
mouse.setButton(0, false);
mouse.reset();
assert.equal(mouse.report()[0], 0);
assert.equal(mouse.setButton(9, true), false);

// Descriptors are well-formed enough to catch a bad edit: balanced collections, expected sizes.
const count = (bytes: readonly number[], value: number) => bytes.filter((b) => b === value).length;
assert.equal(KEYBOARD_DESCRIPTOR.at(-1), 0xc0);
assert.equal(count(KEYBOARD_DESCRIPTOR, 0xa1), 1);
assert.equal(MOUSE_DESCRIPTOR.slice(-2).join(), '192,192');
assert.equal(count(MOUSE_DESCRIPTOR, 0xa1), 2);

console.log('hid reports ok');
