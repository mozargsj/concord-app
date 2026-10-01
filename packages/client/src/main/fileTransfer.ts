import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { RC_FILES, RC_TIMING } from '../common/remoteControl';
import { emitToRenderer, getActiveSession, onSessionEnd } from './remoteControl';

// File transfer inside a remote-control session (spec 35). Security model, in order of importance:
//  - Only with an active session whose permissions include `files`; every frame/IPC call must
//    carry that session's id and come from its peer.
//  - The RECEIVER decides everything: each file needs an explicit OK, it always lands in
//    <Downloads>/Concord Recebidos with a sanitized, never-overwriting name, and is tagged as
//    coming from the Internet zone (Mark of the Web) so SmartScreen treats it as downloaded.
//  - The SENDER can only send what its own user picked in the native file dialog — the renderer
//    never names a path, so a peer (or a compromised renderer) can't make main read arbitrary files.
//  - Nothing is ever opened or executed. One transfer per direction at a time.
// File data streams through main in chunks (never a whole file in memory).

interface Outgoing {
  xid: number;
  filePath: string;
  size: number;
  handle: FileHandle | null;
  position: number;
}

interface Incoming {
  xid: number;
  name: string;
  size: number;
  received: number;
  state: 'pending' | 'receiving';
  handle: FileHandle | null;
  tmpPath: string | null;
  writeQueue: Promise<unknown>;
  timer: ReturnType<typeof setTimeout> | null;
}

let outgoing: Outgoing | null = null;
let incoming: Incoming | null = null;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const RISKY_EXTENSIONS = new Set(['.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.lnk', '.reg', '.dll', '.jar', '.hta', '.cpl', '.msc']);

/** A name a peer sent, made safe to create on this disk: last path segment only, no characters
 * Windows forbids, no reserved device names, no trailing dots/spaces, bounded length. */
export function sanitizeFileName(raw: unknown): string {
  let name = path.basename(String(raw).replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
  name = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (!name || name === '.' || name === '..') name = 'arquivo';
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

export function isRiskyFileName(name: string): boolean {
  return RISKY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

const receiveDir = () => path.join(app.getPath('downloads'), 'Concord Recebidos');

async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const candidate = path.join(dir, n === 0 ? name : `${base} (${n})${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${base}-${randomBytes(4).toString('hex')}${ext}`);
}

function sessionFor(peerId: string | undefined, sid: string | undefined): ReturnType<typeof getActiveSession> {
  const s = getActiveSession();
  if (!s || !s.perms.files) return null;
  if (peerId !== undefined && s.peerId !== peerId) return null;
  if (sid !== undefined && s.sid !== sid) return null;
  return s;
}

async function discardIncoming(): Promise<void> {
  const current = incoming;
  incoming = null;
  if (!current) return;
  if (current.timer) clearTimeout(current.timer);
  await current.writeQueue.catch(() => {});
  await current.handle?.close().catch(() => {});
  if (current.tmpPath) await unlink(current.tmpPath).catch(() => {});
}

async function discardOutgoing(): Promise<void> {
  const current = outgoing;
  outgoing = null;
  await current?.handle?.close().catch(() => {});
}

onSessionEnd(() => {
  void discardIncoming();
  void discardOutgoing();
});

// ---- sender ----------------------------------------------------------------------------------------

ipcMain.handle('rc:files-pick', async (event) => {
  if (!sessionFor(undefined, undefined)) return { error: 'permissao' };
  if (outgoing) return { error: 'ocupado' };
  const window = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = { properties: ['openFile'] };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile() || info.size <= 0 || info.size > RC_FILES.maxBytes) return { error: 'tamanho' };
  if (!sessionFor(undefined, undefined) || outgoing) return { error: 'ocupado' }; // changed while the dialog was open
  const xid = randomBytes(4).readUInt32LE(0);
  outgoing = { xid, filePath, size: info.size, handle: null, position: 0 };
  return { xid, name: path.basename(filePath), size: info.size };
});

/** Next chunk of the picked file, or null at the end (which also releases the file). */
ipcMain.handle('rc:files-read', async (_event, xid: number) => {
  const current = outgoing;
  if (!current || current.xid !== xid || !sessionFor(undefined, undefined)) return null;
  current.handle ??= await open(current.filePath, 'r');
  const buffer = Buffer.allocUnsafe(RC_FILES.chunkBytes);
  const { bytesRead } = await current.handle.read(buffer, 0, buffer.length, current.position);
  if (bytesRead === 0) {
    await discardOutgoing();
    return null;
  }
  current.position += bytesRead;
  return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
});

// ---- receiver --------------------------------------------------------------------------------------

/** An `offer` frame arrived: validate it against the live session and park it until the user
 * answers. Nothing touches the disk before that answer. */
ipcMain.handle('rc:files-incoming', (_event, peerId: string, frame: { sid?: unknown; xid?: unknown; name?: unknown; size?: unknown }) => {
  if (!frame || typeof frame.sid !== 'string' || !sessionFor(peerId, frame.sid)) return { ok: false, reason: 'permissao' };
  if (incoming) return { ok: false, reason: 'ocupado' };
  const { xid, size } = frame;
  if (!Number.isInteger(xid) || (xid as number) < 0 || (xid as number) > 0xffffffff) return { ok: false, reason: 'invalido' };
  if (!Number.isInteger(size) || (size as number) <= 0 || (size as number) > RC_FILES.maxBytes) return { ok: false, reason: 'tamanho' };
  if (typeof frame.name !== 'string' || frame.name.length === 0 || frame.name.length > 1000) return { ok: false, reason: 'invalido' };
  const name = sanitizeFileName(frame.name);
  const pending: Incoming = {
    xid: xid as number,
    name,
    size: size as number,
    received: 0,
    state: 'pending',
    handle: null,
    tmpPath: null,
    writeQueue: Promise.resolve(),
    timer: null
  };
  pending.timer = setTimeout(() => {
    if (incoming !== pending || pending.state !== 'pending') return;
    incoming = null;
    emitToRenderer('rc:files-expired', { xid: pending.xid });
  }, RC_TIMING.solicitationTimeoutMs);
  incoming = pending;
  return { ok: true, name, size: pending.size, risky: isRiskyFileName(name) };
});

ipcMain.handle('rc:files-accept', async (_event, xid: number, accept: boolean) => {
  const current = incoming;
  if (!current || current.xid !== xid || current.state !== 'pending' || !sessionFor(undefined, undefined)) return { ok: false };
  if (!accept) {
    await discardIncoming();
    return { ok: true };
  }
  if (current.timer) clearTimeout(current.timer);
  try {
    const dir = receiveDir();
    await mkdir(dir, { recursive: true });
    current.tmpPath = path.join(dir, `.concord-${randomBytes(6).toString('hex')}.part`);
    current.handle = await open(current.tmpPath, 'wx');
    current.state = 'receiving';
    return { ok: true };
  } catch {
    await discardIncoming();
    return { ok: false };
  }
});

ipcMain.on('rc:files-write', (_event, peerId: string, xid: number, data: Uint8Array) => {
  const current = incoming;
  if (!current || current.xid !== xid || current.state !== 'receiving' || !sessionFor(peerId, undefined)) return;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  // Writes are chained: IPC handlers run concurrently, the file needs them strictly in order.
  current.writeQueue = current.writeQueue.then(async () => {
    if (incoming !== current || !current.handle) return;
    if (current.received + bytes.byteLength > current.size) {
      void discardIncoming(); // the peer is sending more than it announced
      return;
    }
    await current.handle.write(bytes);
    current.received += bytes.byteLength;
  });
});

/** The sender says it is done: check the byte count, then give the file its final name. */
ipcMain.handle('rc:files-finish', async (_event, peerId: string, xid: number) => {
  const current = incoming;
  if (!current || current.xid !== xid || current.state !== 'receiving' || !sessionFor(peerId, undefined)) return { ok: false };
  await current.writeQueue.catch(() => {});
  if (incoming !== current || !current.handle || !current.tmpPath || current.received !== current.size) {
    await discardIncoming();
    return { ok: false };
  }
  await current.handle.close();
  current.handle = null;
  try {
    const finalPath = await uniquePath(receiveDir(), current.name);
    await rename(current.tmpPath, finalPath);
    current.tmpPath = null;
    // Mark of the Web: the file came from another computer over the Internet.
    await writeFile(`${finalPath}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => {});
    incoming = null;
    return { ok: true, name: path.basename(finalPath), folder: receiveDir() };
  } catch {
    await discardIncoming();
    return { ok: false };
  }
});

/** Either side cancelled (or it failed): drop whatever was in flight for this transfer id. */
ipcMain.handle('rc:files-abort', async (_event, xid: number) => {
  if (incoming?.xid === xid) await discardIncoming();
  if (outgoing?.xid === xid) await discardOutgoing();
});
