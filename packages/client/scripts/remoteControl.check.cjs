// Run: npm run build:electron --workspace=@concord/client && node packages/client/scripts/remoteControl.check.cjs
// Exercises main/remoteControl.ts (session authority) with `electron`, the input injector and the
// indicator window replaced by fakes — nothing is ever injected into the real desktop.
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const handlers = new Map();
const listeners = new Map();
const sent = [];
const calls = [];
const fakeElectron = {
  app: { getPath: () => path.join(os.tmpdir(), `rc-check-${process.pid}`), on() {}, whenReady: () => new Promise(() => {}) },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText() {} },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
  powerMonitor: { on() {} }
};
const fakeInjector = new Proxy(
  { isInputAvailable: () => true, startKeyHook: () => true },
  { get: (target, key) => target[key] ?? ((...args) => calls.push([key, ...args])) }
);
const fakeIndicator = { showControlIndicator: (...a) => calls.push(['indicator-show', a[0]]), hideControlIndicator: () => calls.push(['indicator-hide']) };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request.endsWith('/inputInjector')) return fakeInjector;
  if (request.endsWith('/controlIndicator')) return fakeIndicator;
  return realLoad.call(this, request, parent, isMain);
};

const rc = require('../out/electron/main/remoteControl.js');
const invoke = (name, ...args) => handlers.get(name)({}, ...args);
const fire = (name, ...args) => listeners.get(name)({}, ...args);
const window = { on() {}, isDestroyed: () => false, isFocused: () => true, webContents: { on() {}, send: (channel, payload) => sent.push([channel, payload]) } };
rc.attachRemoteControlWindow(window);

const alice = { peerId: 'p-alice', userId: 'u-alice', name: 'Alice' };
const bob = { peerId: 'p-bob', userId: 'u-bob', name: 'Bob' };
const all = { mouse: true, keyboard: true, clipboard: false, files: false };
const called = (name) => calls.filter((c) => c[0] === name);
const lastEnded = () => sent.filter((s) => s[0] === 'rc:ended').at(-1)?.[1];

(async () => {
  // Requests need a shared whole screen and an Online status.
  assert.deepEqual(await invoke('rc:incoming', 'request', alice, all), { ok: false, reason: 'sem-tela-inteira' });
  await invoke('rc:set-share', '1');
  await invoke('rc:set-status', 'busy');
  assert.deepEqual(await invoke('rc:incoming', 'request', alice, all), { ok: false, reason: 'status' });
  await invoke('rc:set-status', 'online');

  // Accept -> controlled session, indicator up, Input Reset target tracked by the injector.
  const verdict = await invoke('rc:incoming', 'request', alice, all);
  assert.equal(verdict.ok, true);
  assert.deepEqual(await invoke('rc:incoming', 'request', bob, all), { ok: false, reason: 'em-sessao' }); // one pending at a time
  const accepted = await invoke('rc:respond', verdict.id, true);
  const sid = accepted.session.sid;
  assert.equal(accepted.session.role, 'controlled');
  assert.equal(called('indicator-show').length, 1);
  assert.deepEqual(await invoke('rc:incoming', 'request', bob, all), { ok: false, reason: 'em-sessao' }); // one control at a time

  // Frames: right session only, replays/stale sequence numbers and strangers dropped.
  const key = (over) => ({ t: 'key', sid, seq: 1, k: 0x1e, down: true, ...over });
  fire('rc:input', alice.peerId, key());
  fire('rc:input', alice.peerId, key()); // replay
  fire('rc:input', alice.peerId, key({ seq: 0 })); // older
  fire('rc:input', bob.peerId, key({ seq: 5 })); // not the controller
  fire('rc:input', alice.peerId, key({ seq: 6, sid: 'other-session' }));
  assert.equal(called('injectKey').length, 1);
  fire('rc:input', alice.peerId, { t: 'btn', sid, seq: 1, b: 0, down: true });
  fire('rc:move', alice.peerId, { t: 'mv', sid, seq: 1, x: 0.5, y: 0.5 });
  fire('rc:move', alice.peerId, { t: 'mv', sid, seq: 1, x: 0.9, y: 0.9 }); // stale
  assert.deepEqual(called('injectMoveNormalized'), [['injectMoveNormalized', '1', 0.5, 0.5]]);
  fire('rc:input', alice.peerId, { t: 'hb', sid, keys: [], buttons: [] });
  assert.equal(called('reconcilePressed').length, 1);

  // Closing the shared screen ends control at once, with Input Reset.
  await invoke('rc:set-share', null);
  assert.equal(lastEnded().reason, 'share-stopped');
  assert.equal(called('resetInjectedInput').length, 1);
  assert.equal(called('indicator-hide').length > 0, true);

  // Mouse permission is enforced per session: keyboard-only grant injects no pointer input.
  await invoke('rc:set-share', '1');
  const v2 = await invoke('rc:incoming', 'request', alice, { mouse: false, keyboard: true, clipboard: false });
  const s2 = (await invoke('rc:respond', v2.id, true)).session.sid;
  const before = called('injectButton').length;
  fire('rc:input', alice.peerId, { t: 'btn', sid: s2, seq: 1, b: 0, down: true });
  assert.equal(called('injectButton').length, before);
  await invoke('rc:end', 'revoked');

  // Capability negotiation: the controller's real-hardware facts (3 buttons, no horizontal wheel)
  // become limits on this PC; it happens once, and garbage can't widen them.
  const v4 = await invoke('rc:incoming', 'request', alice, all);
  const s4 = (await invoke('rc:respond', v4.id, true)).session.sid;
  const caps = { mouse: { present: true, buttons: 3, horizontalWheel: false }, keyboard: { present: true, keysTotal: 101, functionKeys: 12, kind: 'enhanced' } };
  fire('rc:input', alice.peerId, { t: 'caps', sid: s4, caps });
  fire('rc:input', alice.peerId, { t: 'caps', sid: s4, caps: { mouse: { buttons: 5, horizontalWheel: true } } }); // second one ignored
  const buttonsBefore = called('injectButton').length;
  fire('rc:input', alice.peerId, { t: 'btn', sid: s4, seq: 1, b: 2, down: true }); // middle: within the 3 buttons
  fire('rc:input', alice.peerId, { t: 'btn', sid: s4, seq: 2, b: 3, down: true }); // side button: beyond them
  assert.equal(called('injectButton').length, buttonsBefore + 1);
  fire('rc:input', alice.peerId, { t: 'wheel', sid: s4, seq: 1, dx: 300, dy: 100 });
  assert.deepEqual(called('injectWheel').at(-1), ['injectWheel', 0, 100]); // horizontal part dropped
  assert.equal(called('configureBackend').length, 1);
  await invoke('rc:end', 'revoked');

  // Heartbeat watchdog: no frame for heartbeatTimeoutMs -> Input Reset + end.
  const v3 = await invoke('rc:incoming', 'request', alice, all);
  await invoke('rc:respond', v3.id, true);
  const resetsBefore = called('resetInjectedInput').length;
  await new Promise((resolve) => setTimeout(resolve, 3800));
  assert.equal(lastEnded().reason, 'heartbeat');
  assert.equal(called('resetInjectedInput').length, resetsBefore + 1);

  // Cooldown through the real IPC path: 60s, 120s, 240s, 480s, then permanent on the 5th refusal.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  for (const expectedMs of [60_000, 120_000, 240_000, 480_000]) {
    const v = await invoke('rc:incoming', 'request', bob, all);
    assert.equal(v.ok, true);
    await invoke('rc:respond', v.id, false);
    const blocked = await invoke('rc:incoming', 'request', bob, all);
    assert.equal(blocked.reason, 'cooldown');
    assert.ok(Math.abs(blocked.retryInMs - expectedMs) < 1000, `${blocked.retryInMs} vs ${expectedMs}`);
    offset += expectedMs + 1000;
  }
  const fifth = await invoke('rc:incoming', 'request', bob, all);
  await invoke('rc:respond', fifth.id, false);
  offset += 10 * 3_600_000;
  assert.deepEqual(await invoke('rc:incoming', 'request', bob, all), { ok: false, reason: 'bloqueado' }); // permanent survives time
  const list = await invoke('rc:list-blocked');
  assert.equal(list.length, 1);
  assert.equal(list[0].permanent, true);
  assert.equal(await invoke('rc:unblock', bob.userId), true);
  assert.equal((await invoke('rc:incoming', 'request', bob, all)).ok, true);
  Date.now = realNow;

  console.log('remote control main checks ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
