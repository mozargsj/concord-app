// Run: node src/common/inputPolicy.test.ts   (Node 22.6+ strips the types itself)
import assert from 'node:assert/strict';
import { CODE_TO_KEY } from './keyScan.ts';
import { InputGuard } from './inputPolicy.ts';

const k = (code: string) => CODE_TO_KEY[code];
const feed = (guard: InputGuard, steps: Array<[string, boolean]>) => steps.map(([code, down]) => guard.allow(k(code), down));

// Ctrl, Alt down are fine; Delete completing the combination is refused, and so is its key-up.
let guard = new InputGuard();
assert.deepEqual(
  feed(guard, [['ControlLeft', true], ['AltLeft', true], ['Delete', true], ['Delete', false], ['AltLeft', false], ['ControlLeft', false]]),
  [true, true, false, false, true, true]
);

// Same combination in every key order, with either side's modifiers and the numpad Delete.
for (const order of [
  ['Delete', 'ControlLeft', 'AltLeft'],
  ['AltRight', 'Delete', 'ControlRight'],
  ['ControlLeft', 'AltLeft', 'NumpadDecimal'],
  ['NumpadDecimal', 'AltLeft', 'ControlRight']
]) {
  guard = new InputGuard();
  const results = feed(guard, order.map((code) => [code, true] as [string, boolean]));
  assert.equal(results.filter((allowed) => !allowed).length, 1, `${order.join('+')}: exactly the completing key is refused`);
  assert.equal(results.at(-1), false, `${order.join('+')}: the last key completes it`);
}

// Everything that is NOT the SAS stays allowed: Ctrl+Alt+Tab-ish, Ctrl+Shift+Esc, Alt+Delete, Ctrl+Delete, plain Delete.
for (const combo of [['ControlLeft', 'ShiftLeft', 'Escape'], ['AltLeft', 'Delete'], ['ControlLeft', 'Delete'], ['Delete'], ['ControlLeft', 'AltLeft', 'Tab'], ['MetaLeft', 'KeyL']]) {
  guard = new InputGuard();
  assert.ok(feed(guard, combo.map((code) => [code, true] as [string, boolean])).every(Boolean), combo.join('+'));
}

// After the keys are released the guard is clean again: a later, non-SAS use of Delete works.
guard = new InputGuard();
feed(guard, [['ControlLeft', true], ['AltLeft', true], ['Delete', true], ['Delete', false], ['AltLeft', false]]);
assert.equal(guard.allow(k('Delete'), true), true); // only Ctrl is still held
guard.reset();
assert.equal(guard.allow(k('ControlLeft'), true), true);

console.log('input policy ok');
