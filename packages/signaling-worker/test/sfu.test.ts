// Run: node test/sfu.test.ts   (from packages/signaling-worker; Node 22.6+ strips the types itself)
// SFU-mode trust boundary: message shape validation and which tracks a peer may pull.
import assert from 'node:assert/strict';
import { validateClientMessage } from '../src/protocol.ts';
import { resolvePulls } from '../src/sfu.ts';

const ok = (m: unknown) => assert.notEqual(validateClientMessage(m), null, JSON.stringify(m));
const bad = (m: unknown) => assert.equal(validateClientMessage(m), null, JSON.stringify(m));

// sfu-publish: known roles, one track per role, at most one of each
ok({ type: 'sfu-publish', requestId: 'r', fresh: true, sdp: 'v=0', tracks: [{ mid: '0', role: 'mic' }, { mid: '1', role: 'screenVideo' }] });
bad({ type: 'sfu-publish', requestId: 'r', fresh: true, sdp: 'v=0', tracks: [{ mid: '0', role: 'mic' }, { mid: '1', role: 'mic' }] });
bad({ type: 'sfu-publish', requestId: 'r', fresh: true, sdp: 'v=0', tracks: [{ mid: '0', role: 'keyboard' }] });
bad({ type: 'sfu-publish', requestId: 'r', fresh: true, sdp: 'v=0', tracks: [] });
bad({ type: 'sfu-publish', requestId: 'r', sdp: 'v=0', tracks: [{ mid: '0', role: 'mic' }] }); // no fresh
bad({ type: 'sfu-publish', requestId: 'r', fresh: true, sdp: 'x'.repeat(120_001), tracks: [{ mid: '0', role: 'mic' }] });

// sfu-subscribe / unsubscribe / unpublish / renegotiate
ok({ type: 'sfu-subscribe', requestId: 'r', fresh: false, tracks: [{ peerId: 'p2', trackName: 'mic-1' }] });
bad({ type: 'sfu-subscribe', requestId: 'r', fresh: false, tracks: Array.from({ length: 65 }, () => ({ peerId: 'p', trackName: 't' })) });
bad({ type: 'sfu-subscribe', requestId: 'r', fresh: false, tracks: [{ peerId: 'p2' }] });
ok({ type: 'sfu-unsubscribe', requestId: 'r', mids: ['3', '4'] });
bad({ type: 'sfu-unsubscribe', requestId: 'r', mids: [] });
ok({ type: 'sfu-unpublish', requestId: 'r', sdp: 'v=0', mids: ['0'] });
bad({ type: 'sfu-unpublish', requestId: 'r', sdp: 'v=0', mids: ['0', '1', '2', '3', '4', '5'] });
ok({ type: 'sfu-renegotiate', requestId: 'r', sdp: 'v=0' });
bad({ type: 'sfu-renegotiate', requestId: '', sdp: 'v=0' });

// join-room: sfuCapable optional but must be boolean
const join = { type: 'join-room', roomId: 'r', serverId: 's', displayName: 'd', userId: 'u', sessionToken: 't' };
ok(join);
ok({ ...join, sfuCapable: true });
bad({ ...join, sfuCapable: 'yes' });

// resolvePulls: only tracks a live peer of this room announced, never your own, session from the server
const peers = [
  { peerId: 'me', sfu: { pub: 'S-me', tracks: [{ name: 'mic-a' }] } },
  { peerId: 'p2', sfu: { pub: 'S-p2', tracks: [{ name: 'mic-b' }, { name: 'screenVideo-c' }] } },
  { peerId: 'p3' } // in the room, published nothing
];
assert.deepEqual(
  resolvePulls(
    [
      { peerId: 'p2', trackName: 'mic-b' },
      { peerId: 'p2', trackName: 'camera-x' }, // not announced
      { peerId: 'me', trackName: 'mic-a' }, // self
      { peerId: 'p3', trackName: 'mic-z' }, // no session
      { peerId: 'ghost', trackName: 'mic-b' } // not in the room
    ],
    peers,
    'me'
  ),
  [{ peerId: 'p2', trackName: 'mic-b', sessionId: 'S-p2' }, null, null, null, null]
);

console.log('sfu.test.ts: ok');
