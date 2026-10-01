// Run: npm run build:electron --workspace=@concord/client && node packages/client/scripts/virtualHid.check.cjs
// Exercises the Virtual HID backend (main/virtualHidBackend.ts + the injector's backend switch)
// against a FAKE service on a temporary named pipe. `electron` is faked and the native addon can't
// load under plain Node, so nothing can ever reach the real keyboard/mouse.
const assert = require('node:assert/strict');
const net = require('node:net');
const Module = require('node:module');

const pipe = `\\\\.\\pipe\\concord-vhid-test-${process.pid}`;
process.env.CONCORD_VHID_PIPE = pipe;

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      screen: {
        getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
        dipToScreenRect: (_window, rect) => rect
      }
    };
  }
  return realLoad.call(this, request, parent, isMain);
};
const injector = require('../out/electron/main/inputInjector.js');

function startFakeService(hello) {
  const received = [];
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.write(`${JSON.stringify(hello)}\n`);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        received.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(pipe, () => resolve({ server, received, connections })));
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
const take = (received) => received.splice(0).map((m) => `${m.d}:${m.r}`);

(async () => {
  // No service on the pipe -> plain SendInput.
  assert.equal(await injector.prepareBackend(), 'sendinput');

  // A service that doesn't speak our hello is not trusted.
  let fake = await startFakeService({ hello: 'something-else', v: 1 });
  assert.equal(await injector.prepareBackend(), 'sendinput');
  await new Promise((resolve) => fake.server.close(resolve));

  // The real thing: connects, then input becomes HID reports.
  fake = await startFakeService({ hello: 'concord-virtual-hid', v: 1 });
  assert.equal(await injector.prepareBackend(), 'virtual-hid');
  const KEY = { ctrl: 0x1d, shift: 0x2a, esc: 0x01 };
  injector.injectKey(KEY.ctrl, true);
  injector.injectKey(KEY.shift, true);
  injector.injectKey(KEY.esc, true);
  await settle();
  assert.deepEqual(take(fake.received), ['kbd:0100000000000000', 'kbd:0300000000000000', 'kbd:0300290000000000']);
  injector.injectKey(KEY.esc, false);
  await settle();
  assert.deepEqual(take(fake.received), ['kbd:0300000000000000']);

  // Ctrl+Alt+Del can never be completed by remote input, even on a real-HID backend: the Delete is
  // dropped (with its key-up) and no report for it is ever sent.
  injector.resetInjectedInput();
  await settle();
  take(fake.received); // discard the reset's own neutral reports
  injector.injectKey(0x1d, true); // Ctrl
  injector.injectKey(0x38, true); // Alt
  injector.injectKey(0x153, true); // Delete -> refused
  injector.injectKey(0x153, false);
  injector.injectKey(0x38, false);
  injector.injectKey(0x1d, false);
  await settle();
  assert.deepEqual(take(fake.received), ['kbd:0100000000000000', 'kbd:0500000000000000', 'kbd:0100000000000000', 'kbd:0000000000000000']);

  injector.injectButton(0, true);
  injector.injectMoveNormalized('1', 1, 1); // bottom-right corner of the only display
  injector.injectWheel(0, -100); // one notch up
  await settle();
  assert.deepEqual(take(fake.received), ['mouse:01000000000000', 'mouse:01ff7fff7f0000', 'mouse:01ff7fff7f0100']);

  // Input Reset: everything still held is released and both devices get neutral-state reports.
  injector.resetInjectedInput();
  await settle();
  const reset = take(fake.received);
  assert.ok(reset.includes('kbd:0000000000000000'), reset.join());
  assert.ok(reset.at(-1).startsWith('mouse:00'), reset.join());

  // The service vanishing mid-session must be reported (the session ends instead of going silent).
  let lost = 0;
  injector.setBackendLostHandler(() => lost++);
  for (const socket of fake.connections) socket.destroy();
  await settle();
  assert.equal(lost, 1);
  await new Promise((resolve) => fake.server.close(resolve));

  injector.releaseBackend();
  console.log('virtual hid backend checks ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
