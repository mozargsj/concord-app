// Run: node src/common/cooldown.test.ts   (Node 22.6+ strips the types itself)
import assert from 'node:assert/strict';
import { blockDurationMs, blockStatus, recordRefusal, type BlockRecord } from './cooldown.ts';

const MIN = 60_000;
let t = 0;
let rec: BlockRecord | undefined;

// 1st..4th refusal inside an hour: 60s, 120s, 240s, 480s
for (const expected of [1, 2, 4, 8]) {
  rec = recordRefusal(rec, t);
  const status = blockStatus(rec, t);
  assert.deepEqual(status, { blocked: true, permanent: false, retryInMs: expected * MIN });
  t += expected * MIN; // wait the cooldown out, then the sender asks again and is refused again
  assert.equal(blockStatus(rec, t).blocked, false);
}
assert.equal(blockDurationMs(3), 4 * MIN);

// 5th refusal inside the same hour: permanent, and stays so no matter how long passes
rec = recordRefusal(rec, t);
assert.deepEqual(blockStatus(rec, t), { blocked: true, permanent: true });
assert.deepEqual(blockStatus(rec, t + 10 * 3_600_000), { blocked: true, permanent: true });

// Waiting out the window forgets older refusals: next refusal is a "first" one again
let spaced: BlockRecord | undefined;
for (let i = 0; i < 6; i++) {
  spaced = recordRefusal(spaced, i * 2 * 3_600_000);
  assert.equal(spaced.refusals.length, 1);
  assert.equal(spaced.permanent, false);
}
console.log('cooldown ok');
