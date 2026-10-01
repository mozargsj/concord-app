// Run: npm run build:electron --workspace=@concord/client && node packages/client/scripts/fileTransfer.check.cjs
// Exercises main/fileTransfer.ts with `electron` and the session module replaced by fakes; all
// files live in a temp directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-files-'));
const downloads = path.join(root, 'Downloads');
const source = path.join(root, 'origem.bin');
fs.mkdirSync(downloads);
const payload = Buffer.alloc(200_000, 7);
fs.writeFileSync(source, payload);

const handlers = new Map();
const listeners = new Map();
const endListeners = [];
let session = { sid: 's1', peerId: 'peer', perms: { mouse: false, keyboard: false, clipboard: false, files: true } };
const fakeElectron = {
  app: { getPath: () => downloads },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [source] }) },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) }
};
const fakeSession = {
  getActiveSession: () => session,
  onSessionEnd: (fn) => endListeners.push(fn),
  emitToRenderer() {}
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === './remoteControl') return fakeSession;
  return realLoad.call(this, request, parent, isMain);
};

const ft = require('../out/electron/main/fileTransfer.js');
const invoke = (name, ...args) => handlers.get(name)({ sender: {} }, ...args);
const fire = (name, ...args) => listeners.get(name)({}, ...args);
const received = path.join(downloads, 'Concord Recebidos');

(async () => {
  // Names from a peer are made safe before they ever touch the disk.
  assert.equal(ft.sanitizeFileName('..\\..\\Windows\\system32\\evil.dll'), 'evil.dll');
  assert.equal(ft.sanitizeFileName('a<b>:c|d?.txt'), 'a_b__c_d_.txt');
  assert.equal(ft.sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(ft.sanitizeFileName('nome.'), 'nome');
  assert.equal(ft.sanitizeFileName('   '), 'arquivo');
  assert.ok(ft.sanitizeFileName('x'.repeat(300) + '.pdf').length <= 120);
  assert.equal(ft.isRiskyFileName('setup.EXE'), true);
  assert.equal(ft.isRiskyFileName('foto.png'), false);

  // Sender: only a file picked in the dialog can be read, chunk by chunk, until the end.
  const picked = await invoke('rc:files-pick');
  assert.equal(picked.size, payload.length);
  let total = 0;
  const sentChunks = [];
  for (;;) {
    const chunk = await invoke('rc:files-read', picked.xid);
    if (!chunk) break;
    sentChunks.push(Buffer.from(chunk));
    total += chunk.byteLength;
  }
  assert.equal(total, payload.length);
  assert.equal(await invoke('rc:files-read', picked.xid), null); // released after EOF

  // Receiver: nothing is written before the user accepts, and the file lands sanitized + unique.
  const offer = { sid: 's1', xid: 42, name: '..\\..\\segredo.txt', size: payload.length };
  assert.equal((await invoke('rc:files-incoming', 'stranger', offer)).ok, false); // not the session peer
  assert.equal((await invoke('rc:files-incoming', 'peer', { ...offer, sid: 'old' })).ok, false); // old session
  assert.equal((await invoke('rc:files-incoming', 'peer', { ...offer, size: 3 * 1024 ** 3 })).reason, 'tamanho');
  const verdict = await invoke('rc:files-incoming', 'peer', offer);
  assert.deepEqual([verdict.ok, verdict.name, verdict.risky], [true, 'segredo.txt', false]);
  assert.equal(fs.existsSync(received), false, 'nothing on disk before the answer');
  assert.equal((await invoke('rc:files-incoming', 'peer', { ...offer, xid: 43 })).reason, 'ocupado'); // one at a time
  assert.equal((await invoke('rc:files-accept', 42, true)).ok, true);
  for (const chunk of sentChunks) fire('rc:files-write', 'peer', 42, new Uint8Array(chunk));
  const done = await invoke('rc:files-finish', 'peer', 42);
  assert.equal(done.ok, true);
  assert.equal(done.name, 'segredo.txt');
  assert.deepEqual(fs.readFileSync(path.join(received, 'segredo.txt')), payload);
  assert.equal(fs.readdirSync(received).filter((f) => f.endsWith('.part')).length, 0);
  if (process.platform === 'win32') {
    assert.match(fs.readFileSync(path.join(received, 'segredo.txt') + ':Zone.Identifier', 'utf8'), /ZoneId=3/);
  }

  // Same name again never overwrites.
  await invoke('rc:files-incoming', 'peer', { ...offer, xid: 44 });
  await invoke('rc:files-accept', 44, true);
  for (const chunk of sentChunks) fire('rc:files-write', 'peer', 44, new Uint8Array(chunk));
  assert.equal((await invoke('rc:files-finish', 'peer', 44)).name, 'segredo (1).txt');

  // More bytes than announced, or fewer, is discarded; so is a refused offer.
  await invoke('rc:files-incoming', 'peer', { ...offer, xid: 45, size: 10 });
  await invoke('rc:files-accept', 45, true);
  fire('rc:files-write', 'peer', 45, new Uint8Array(11));
  assert.equal((await invoke('rc:files-finish', 'peer', 45)).ok, false);
  await invoke('rc:files-incoming', 'peer', { ...offer, xid: 46, size: 10 });
  await invoke('rc:files-accept', 46, true);
  fire('rc:files-write', 'peer', 46, new Uint8Array(4));
  assert.equal((await invoke('rc:files-finish', 'peer', 46)).ok, false);
  await invoke('rc:files-incoming', 'peer', { ...offer, xid: 47 });
  assert.equal((await invoke('rc:files-accept', 47, false)).ok, true);
  assert.equal(fs.readdirSync(received).filter((f) => f.endsWith('.part')).length, 0);

  // The session ending mid-transfer drops the partial file.
  await invoke('rc:files-incoming', 'peer', { ...offer, xid: 48 });
  await invoke('rc:files-accept', 48, true);
  fire('rc:files-write', 'peer', 48, new Uint8Array(100));
  for (const fn of endListeners) fn();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.readdirSync(received).filter((f) => f.endsWith('.part')).length, 0);

  // Without the files permission (or without a session) nothing works.
  session = { ...session, perms: { ...session.perms, files: false } };
  assert.deepEqual(await invoke('rc:files-pick'), { error: 'permissao' });
  assert.equal((await invoke('rc:files-incoming', 'peer', offer)).ok, false);
  session = null;
  assert.equal((await invoke('rc:files-incoming', 'peer', offer)).ok, false);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('file transfer main checks ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
