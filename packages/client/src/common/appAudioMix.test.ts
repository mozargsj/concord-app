// Run: node src/common/appAudioMix.test.ts   (Node 22.6+ strips the types itself)
import assert from 'node:assert/strict';
import { pidsToCapture } from './appAudioMix.ts';

const s = (pid: number, exe: string, ancestors: number[] = []) => ({ pid, exe, ancestors });

// Nothing excluded: every session is captured
assert.deepEqual(pidsToCapture([s(10, 'Spotify.exe'), s(20, 'game.exe')], []), [10, 20]);

// Excluded by exe name, case-insensitive
assert.deepEqual(pidsToCapture([s(10, 'Spotify.exe'), s(20, 'game.exe')], ['spotify.EXE']), [20]);

// Launcher (pid 1) plays sound and launched the excluded game (pid 2): capturing the launcher's tree
// would bring the game in, so the launcher is skipped; an unrelated app still goes in
assert.deepEqual(
  pidsToCapture([s(1, 'launcher.exe'), s(2, 'game.exe', [1]), s(3, 'Spotify.exe')], ['game.exe']),
  [3]
);

// Parent and child both have sessions, nothing excluded: only the parent (its tree carries the child)
assert.deepEqual(pidsToCapture([s(1, 'app.exe'), s(2, 'helper.exe', [1])], []), [1]);

// Grandchild under an excluded middle process: middle is out, top is skipped (tree leaks the middle),
// the grandchild is captured on its own
assert.deepEqual(
  pidsToCapture([s(1, 'top.exe'), s(2, 'mid.exe', [1]), s(3, 'leaf.exe', [2, 1])], ['mid.exe']),
  [3]
);

console.log('appAudioMix: ok');
