// Run: node src/common/keyScan.test.ts   (Node 22.6+ strips the types itself)
import assert from 'node:assert/strict';
import { CODE_TO_KEY, describeKey, VALID_KEY_IDS } from './keyScan.ts';

assert.deepEqual(describeKey(CODE_TO_KEY.KeyA), { name: 'KeyA', hex: '0x1E', ascii: 65 });
assert.deepEqual(describeKey(CODE_TO_KEY.Digit0), { name: 'Digit0', hex: '0x0B', ascii: 48 });
assert.deepEqual(describeKey(CODE_TO_KEY.Space), { name: 'Space', hex: '0x39', ascii: 32 });
assert.equal(describeKey(CODE_TO_KEY.Enter).ascii, 13);
assert.equal(describeKey(CODE_TO_KEY.Escape).ascii, 27);
assert.equal(describeKey(CODE_TO_KEY.Delete).ascii, 127);
// Extended keys keep the 0x100 offset in the hex shown; keys with no ASCII say so.
assert.deepEqual(describeKey(CODE_TO_KEY.ArrowLeft), { name: 'ArrowLeft', hex: '0x14B', ascii: null });
assert.deepEqual(describeKey(CODE_TO_KEY.F5), { name: 'F5', hex: '0x3F', ascii: null });
assert.equal(describeKey(0x7f).name, 'desconhecida');
// Every valid key describes to a real name, and A-Z all map to their uppercase ASCII code.
for (const id of VALID_KEY_IDS) assert.notEqual(describeKey(id).name, 'desconhecida');
for (let c = 65; c <= 90; c++) assert.equal(describeKey(CODE_TO_KEY[`Key${String.fromCharCode(c)}`]).ascii, c);
console.log('key scan ok');
