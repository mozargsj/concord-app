// Run: node src/common/deviceCaps.test.ts   (Node 22.6+ strips the types itself)
import assert from 'node:assert/strict';
import { capsFromNative, negotiateCaps, VIRTUAL_SUPPORT } from './deviceCaps.ts';

// A plain 3-button wheel mouse + standard keyboard: everything is covered, nothing to warn about.
const plain = capsFromNative({ mouse: { count: 1, buttons: 3, horizontalWheel: false }, keyboard: { count: 1, keysTotal: 101, functionKeys: 12, type: 4 } });
assert.deepEqual(plain, {
  mouse: { present: true, buttons: 3, horizontalWheel: false },
  keyboard: { present: true, keysTotal: 101, functionKeys: 12, kind: 'enhanced' }
});
assert.deepEqual(negotiateCaps(plain), { buttons: 3, horizontalWheel: false, warnings: [] });

// Modern HID keyboards report type 81 on Windows; that is a regular keyboard too.
assert.equal(capsFromNative({ mouse: { count: 1, buttons: 3, horizontalWheel: false }, keyboard: { count: 1, keysTotal: 265, functionKeys: 12, type: 81 } }).keyboard.kind, 'enhanced');

// A 7-button gaming mouse: only the first 5 are forwarded, and the user is told.
const gaming = capsFromNative({ mouse: { count: 2, buttons: 7, horizontalWheel: true }, keyboard: { count: 1, keysTotal: 104, functionKeys: 12, type: 4 } });
const negotiated = negotiateCaps(gaming);
assert.equal(negotiated.buttons, VIRTUAL_SUPPORT.maxButtons);
assert.equal(negotiated.horizontalWheel, true);
assert.equal(negotiated.warnings.length, 1);
assert.match(negotiated.warnings[0], /7 botões/);

// F13-F24 and Japanese/Korean keyboards each produce a warning.
const exotic = capsFromNative({ mouse: { count: 1, buttons: 5, horizontalWheel: false }, keyboard: { count: 1, keysTotal: 109, functionKeys: 24, type: 7 } });
assert.equal(negotiateCaps(exotic).warnings.length, 2);

// Untrusted / missing input never throws and falls back to the permissive default.
for (const garbage of [undefined, null, 5, 'x', {}, { mouse: { buttons: 'many' }, keyboard: 3 }, { mouse: { buttons: -4, horizontalWheel: 'yes' } }]) {
  const result = negotiateCaps(garbage);
  assert.ok(result.buttons >= 1 && result.buttons <= VIRTUAL_SUPPORT.maxButtons, JSON.stringify(garbage));
  assert.equal(typeof result.horizontalWheel, 'boolean');
}
assert.deepEqual(negotiateCaps(undefined), { buttons: 5, horizontalWheel: true, warnings: [] });
// Absurd numbers are clamped rather than trusted.
assert.equal(negotiateCaps({ mouse: { buttons: 1e9 } }).buttons, 5);

// Nothing identifying exists in the shape at all.
assert.deepEqual(Object.keys(plain.mouse).sort(), ['buttons', 'horizontalWheel', 'present']);
assert.deepEqual(Object.keys(plain.keyboard).sort(), ['functionKeys', 'keysTotal', 'kind', 'present']);

console.log('device caps ok');
