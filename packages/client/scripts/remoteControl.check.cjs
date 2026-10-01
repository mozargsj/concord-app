// Run: npm run build:electron --workspace=@concord/client && node packages/client/scripts/remoteControl.check.cjs
// Exercises main/remoteControl.ts (session authority) with `electron`, the input injector and the
// indicator window replaced by fakes — nothing is ever injected into the real desktop.
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const handlers = new Map();
let saveTarget = null;
const listeners = new Map();
const sent = [];
const calls = [];
const fakeElectron = {
  app: { getPath: () => path.join(os.tmpdir(), `rc-check-${process.pid}`), getVersion: () => '9.9.9', on() {}, whenReady: () => new Promise(() => {}) },
  screen: {
    getAllDisplays: () => [{ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1.25 }],
    getPrimaryDisplay: () => ({ id: 1 })
  },
  dialog: { showSaveDialog: async () => (saveTarget ? { canceled: false, filePath: saveTarget } : { canceled: true }) },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  clipboard: { readText: () => '', writeText() {} },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
  powerMonitor: { on() {} }
};
const fakeInjector = new Proxy(
  {
    isInputAvailable: () => true,
    startKeyHook: () => true,
    // Delete (0x153) plays the part of a key the Ctrl+Alt+Del guard refuses; everything else is accepted.
    injectKey: (k, d) => (calls.push(['injectKey', k, d]), k === 0x153 ? 'guard' : k === 0x2e ? 'fail' : 'ok'),
    injectStats: { injected: 0, failed: 0, lastDetail: 'SendInput recusado (erro 5 — acesso negado)' },
    readHookStats: () => ({ seen: 7, swallowed: 5, delivered: 5 }),
    currentBackend: () => 'sendinput'
  },
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

  // Input diagnostics: off by default (nothing recorded), on = every event with what happened to it.
  const v5 = await invoke('rc:incoming', 'request', alice, all);
  const s5 = (await invoke('rc:respond', v5.id, true)).session.sid;
  fire('rc:input', alice.peerId, { t: 'key', sid: s5, seq: 1, k: 0x1e, down: true });
  assert.deepEqual(await invoke('rc:diag-items', 0), [], 'nothing is recorded while diagnostics are off');
  await invoke('rc:diag-enable', true);
  fire('rc:input', alice.peerId, { t: 'key', sid: s5, seq: 2, k: 0x1e, down: false }); // applied
  fire('rc:input', alice.peerId, { t: 'key', sid: s5, seq: 2, k: 0x1e, down: false }); // replay
  fire('rc:input', alice.peerId, { t: 'key', sid: s5, seq: 3, k: 0x153, down: true }); // refused by the guard
  fire('rc:input', alice.peerId, { t: 'key', sid: s5, seq: 4, k: 0x2e, down: true }); // Windows refuses it
  fire('rc:input', alice.peerId, { t: 'btn', sid: s5, seq: 1, b: 0, down: true });
  fire('rc:move', alice.peerId, { t: 'mv', sid: s5, seq: 1, x: 0.25, y: 0.75 });
  const items = await invoke('rc:diag-items', 0);
  assert.deepEqual(
    items.map((i) => [i.kind, i.seq, i.value, i.down, i.outcome]),
    [['key', 2, 0x1e, false, 'ok'], ['key', 2, 0x1e, false, 'seq'], ['key', 3, 0x153, true, 'guard'], ['key', 4, 0x2e, true, 'fail'], ['btn', 1, 0, true, 'ok'], ['mv', 1, 0, false, 'ok']]
  );
  assert.deepEqual([items.at(-1).x, items.at(-1).y], [0.25, 0.75]);
  assert.match(items.find((i) => i.outcome === 'fail').detail, /erro 5/, 'a refusal carries the reason from Windows');
  assert.equal(items.find((i) => i.outcome === 'ok').detail, undefined);
  const diag = await invoke('rc:diag');
  assert.deepEqual([diag.hookSeen, diag.hookSwallowed, diag.hookDelivered], [7, 5, 5]);
  assert.equal((await invoke('rc:diag-items', items[2].id)).length, 3, 'only newer events after the given id');
  // The report: system facts for the file, and saving is a local write the user confirms in a dialog.
  const system = await invoke('rc:diag-system');
  assert.deepEqual([system.appVersion, system.backend, system.displays.length, system.displays[0].primary], ['9.9.9', 'sendinput', 1, true]);
  assert.deepEqual(await invoke('rc:diag-save', 'texto', 'controlled'), { ok: false }, 'dialog cancelled -> nothing written');
  saveTarget = path.join(os.tmpdir(), `rc-report-${process.pid}.txt`);
  const saved = await invoke('rc:diag-save', 'relatório ação', 'controller');
  assert.equal(saved.ok, true);
  const bytes = require('node:fs').readFileSync(saveTarget);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Notepad shows accents');
  assert.equal(bytes.subarray(3).toString('utf8'), 'relatório ação');
  require('node:fs').unlinkSync(saveTarget);
  assert.deepEqual(await invoke('rc:diag-save', '', 'controller'), { ok: false });

  await invoke('rc:diag-enable', false);
  assert.deepEqual(await invoke('rc:diag-items', 0), [], 'turning it off clears everything');
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
