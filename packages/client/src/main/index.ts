import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage } from 'electron';
import dotenv from 'dotenv';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loginWithGoogle } from './googleAuth';
import { checkForUpdatesOnStartup } from './autoUpdate';

const isDev = !app.isPackaged;

// Bare `import 'dotenv/config'` resolves `.env` relative to process.cwd() — for a packaged app
// that's wherever the user launched the .exe FROM (Desktop, Downloads...), never the install
// directory, so GOOGLE_OAUTH_CLIENT_ID/SECRET came back silently empty and loginWithGoogle threw
// before ever opening a browser. Dev mode keeps reading packages/client/.env like before;
// packaged mode reads a .env sitting next to the installed .exe itself (app.getPath('exe') is
// cwd-independent), so real credentials can be dropped in post-install without rebuilding.
dotenv.config({
  path: isDev ? path.join(__dirname, '../../../.env') : path.join(path.dirname(app.getPath('exe')), '.env')
});

const sessionFilePath = () => path.join(app.getPath('userData'), 'session.enc');
const imageCacheDir = () => path.join(app.getPath('userData'), 'imageCache');
const soundCacheDir = () => path.join(app.getPath('userData'), 'soundCache');
const soundTempCacheDir = () => path.join(app.getPath('userData'), 'soundTempCache');

interface SoundMetaFile {
  id: string;
  name: string;
  emoji: string;
  volume: number;
  durationMs: number;
  hash: string;
  mimeType: string;
}

// Downloaded-but-not-yet-adopted sounds from other peers (decisions.md — downloading ≠ adding to
// "meus áudios"): a separate cache from soundCacheDir, self-expiring after 7 days so previewing a
// bunch of peers' sounds without ever confirming any of them doesn't grow disk usage forever.
const TEMP_SOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface TempSoundMetaFile {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  emoji: string;
  durationMs: number;
  hash: string;
  mimeType: string;
  downloadedAt: number;
}

/** Best-effort sweep of expired temp sounds — called once at startup, not on a running timer
 * (the app isn't usually left open for 7 days straight, next launch is a fine cadence). */
async function cleanupExpiredTempSounds(): Promise<void> {
  const dir = soundTempCacheDir();
  const entries = await readdir(dir).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const meta = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as TempSoundMetaFile;
          if (now - meta.downloadedAt <= TEMP_SOUND_TTL_MS) return;
          await unlink(path.join(dir, name)).catch(() => {});
          await unlink(path.join(dir, `${meta.id}.bin`)).catch(() => {});
        } catch {
          // corrupt/unreadable metadata — leave it, not worth crashing startup over
        }
      })
  );
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
};

// Single-instance lock — only enforced for the packaged app. Dev mode deliberately allows
// multiple windows/processes: that's how two peers are tested locally (npm run dev:electron
// run twice). Packaged Concord should never run as two processes; launching it again just
// focuses the window that's already open instead of starting a redundant second instance.
const hasSingleInstanceLock = isDev || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

// Best-effort window to let the renderer tear down an active call cleanly (stop mic/camera,
// close the mesh + signaling socket) before the process actually exits — so other participants
// see the disconnect right away instead of waiting for a TCP timeout. Not an ack round-trip on
// purpose: track-stop/socket-close are effectively synchronous locally, a fixed short wait is
// simpler than plumbing a renderer ack and covers it comfortably.
const QUIT_CLEANUP_GRACE_MS = 400;

// Native dialog.showMessageBox looks like generic OS chrome — this asks the renderer to show
// a modal that matches the app's own design instead, and waits for the user's choice back.
async function confirmAndClose(window: BrowserWindow, markConfirmed: () => void): Promise<void> {
  const confirmed = await new Promise<boolean>((resolve) => {
    ipcMain.once('app:confirm-close-response', (_event, value: boolean) => resolve(value));
    window.webContents.send('app:confirm-close-request');
  });
  if (!confirmed) return;

  window.webContents.send('app:before-quit');
  await new Promise((resolve) => setTimeout(resolve, QUIT_CLEANUP_GRACE_MS));

  markConfirmed();
  window.close();
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1e1f22',
    // Packaged builds get the icon embedded in the .exe by electron-builder (win.icon in
    // electron-builder.yml) — build/icon.ico isn't bundled into resources, so only wire this
    // up in dev, where the taskbar icon would otherwise default to Electron's own icon.
    ...(isDev ? { icon: path.join(__dirname, '../../../build/icon.ico') } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  let isCloseConfirmed = false;
  window.on('close', (event) => {
    if (isCloseConfirmed) return;
    event.preventDefault();
    void confirmAndClose(window, () => {
      isCloseConfirmed = true;
    });
  });

  window.on('maximize', () => window.webContents.send('window:maximized-change', true));
  window.on('unmaximize', () => window.webContents.send('window:maximized-change', false));

  // Waits for the page's own script (and its onUpdateStatus listener) to be ready before
  // sending anything — checkForUpdatesOnStartup's status events would otherwise risk arriving
  // before the renderer is listening for them.
  window.webContents.once('did-finish-load', () => {
    checkForUpdatesOnStartup(window, isDev);
  });

  if (isDev) {
    window.loadURL('http://localhost:5173');
  } else {
    window.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }
}

ipcMain.on('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on('window:maximize-toggle', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.on('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle('media:pick-image', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[extension];
  if (!mimeType) return null;

  const buffer = await readFile(filePath);
  return {
    fileName: path.basename(filePath),
    mimeType,
    data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
});

// Cache key is derived from a userId/serverId that can arrive over the signaling protocol from
// an untrusted peer (see roomManager.joinRoom) — sanitized before touching the filesystem so a
// malicious peer claiming a crafted "userId" can't write outside imageCache/ (path traversal).
function sanitizeCacheKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

ipcMain.handle('image-cache:save', async (_event, key: string, data: ArrayBuffer, mimeType: string) => {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType];
  if (!extension) return false;
  const safeKey = sanitizeCacheKey(key);
  const dir = imageCacheDir();
  await mkdir(dir, { recursive: true });
  // One cached file per key — clear any stale extension from a previous save with a different
  // mime type before writing the new one, so load() never finds two matches for the same key.
  const existing = await readdir(dir).catch(() => []);
  await Promise.all(
    existing
      .filter((name) => name.startsWith(`${safeKey}.`))
      .map((name) => unlink(path.join(dir, name)).catch(() => {}))
  );
  await writeFile(path.join(dir, `${safeKey}${extension}`), Buffer.from(data));
  return true;
});

ipcMain.handle('image-cache:load', async (_event, key: string) => {
  const safeKey = sanitizeCacheKey(key);
  const dir = imageCacheDir();
  const existing = await readdir(dir).catch(() => []);
  const match = existing.find((name) => name.startsWith(`${safeKey}.`));
  if (!match) return null;
  const mimeType = IMAGE_MIME_TYPES[path.extname(match).toLowerCase()];
  if (!mimeType) return null;
  const buffer = await readFile(path.join(dir, match));
  return {
    mimeType,
    data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
});

ipcMain.handle('media:pick-audio', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile'],
    // No format allowlist tied to a conversion library — decisions.md deliberately accepts
    // whatever Chromium's decodeAudioData can decode natively, this filter is just a UX
    // shortlist of common containers, not the real acceptance check (that happens on decode).
    filters: [{ name: 'Áudio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'] }]
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const buffer = await readFile(filePath);
  return {
    fileName: path.basename(filePath),
    data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
});

// Same id-sanitizing rationale as sanitizeCacheKey above — soundIds stay local-only for now
// (Fase A, no P2P transfer yet), but the id is still user-provided (crypto.randomUUID() from
// the renderer), so this costs nothing and avoids diverging from the established pattern.
function sanitizeSoundId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

ipcMain.handle('sound-cache:list', async () => {
  const dir = soundCacheDir();
  const entries = await readdir(dir).catch(() => []);
  const jsonNames = entries.filter((name) => name.endsWith('.json'));
  const sounds = await Promise.all(
    jsonNames.map(async (name) => {
      try {
        const meta = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as SoundMetaFile;
        const audio = await readFile(path.join(dir, `${meta.id}.bin`));
        return {
          ...meta,
          data: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)
        };
      } catch {
        return null; // metadata without a matching .bin (or corrupt json) — skip rather than crash the list
      }
    })
  );
  return sounds.filter((sound): sound is NonNullable<typeof sound> => sound !== null);
});

ipcMain.handle('sound-cache:load-bytes', async (_event, id: string) => {
  const safeId = sanitizeSoundId(id);
  const dir = soundCacheDir();
  try {
    const meta = JSON.parse(await readFile(path.join(dir, `${safeId}.json`), 'utf8')) as SoundMetaFile;
    const audio = await readFile(path.join(dir, `${safeId}.bin`));
    return { mimeType: meta.mimeType, data: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) };
  } catch {
    return null;
  }
});

ipcMain.handle('sound-cache:save', async (_event, meta: SoundMetaFile, data: ArrayBuffer) => {
  const safeId = sanitizeSoundId(meta.id);
  const dir = soundCacheDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${safeId}.bin`), Buffer.from(data));
  await writeFile(path.join(dir, `${safeId}.json`), JSON.stringify({ ...meta, id: safeId }));
  return true;
});

ipcMain.handle(
  'sound-cache:update-meta',
  async (_event, id: string, patch: Partial<Pick<SoundMetaFile, 'name' | 'emoji' | 'volume'>>) => {
    const safeId = sanitizeSoundId(id);
    const filePath = path.join(soundCacheDir(), `${safeId}.json`);
    try {
      const meta = JSON.parse(await readFile(filePath, 'utf8')) as SoundMetaFile;
      await writeFile(filePath, JSON.stringify({ ...meta, ...patch }));
      return true;
    } catch {
      return false;
    }
  }
);

ipcMain.handle('sound-cache:delete', async (_event, id: string) => {
  const safeId = sanitizeSoundId(id);
  const dir = soundCacheDir();
  await unlink(path.join(dir, `${safeId}.bin`)).catch(() => {});
  await unlink(path.join(dir, `${safeId}.json`)).catch(() => {});
  return true;
});

ipcMain.handle('sound-temp-cache:list', async () => {
  const dir = soundTempCacheDir();
  const entries = await readdir(dir).catch(() => []);
  const jsonNames = entries.filter((name) => name.endsWith('.json'));
  const sounds = await Promise.all(
    jsonNames.map(async (name) => {
      try {
        const meta = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as TempSoundMetaFile;
        const audio = await readFile(path.join(dir, `${meta.id}.bin`));
        return {
          ...meta,
          data: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)
        };
      } catch {
        return null;
      }
    })
  );
  return sounds.filter((sound): sound is NonNullable<typeof sound> => sound !== null);
});

ipcMain.handle('sound-temp-cache:save', async (_event, meta: TempSoundMetaFile, data: ArrayBuffer) => {
  const safeId = sanitizeSoundId(meta.id);
  const dir = soundTempCacheDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${safeId}.bin`), Buffer.from(data));
  await writeFile(path.join(dir, `${safeId}.json`), JSON.stringify({ ...meta, id: safeId }));
  return true;
});

ipcMain.handle('sound-temp-cache:delete', async (_event, id: string) => {
  const safeId = sanitizeSoundId(id);
  const dir = soundTempCacheDir();
  await unlink(path.join(dir, `${safeId}.bin`)).catch(() => {});
  await unlink(path.join(dir, `${safeId}.json`)).catch(() => {});
  return true;
});

ipcMain.handle('auth:login-with-google', async () => {
  return loginWithGoogle();
});

ipcMain.handle('session:save', async (_event, token: string) => {
  if (!safeStorage.isEncryptionAvailable()) return;
  await writeFile(sessionFilePath(), safeStorage.encryptString(token));
});

ipcMain.handle('session:load', async () => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = await readFile(sessionFilePath());
    return safeStorage.decryptString(encrypted);
  } catch {
    return null;
  }
});

ipcMain.handle('session:clear', async () => {
  await unlink(sessionFilePath()).catch(() => {});
});

ipcMain.handle('screen:get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 150, height: 150 }
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnailDataUrl: source.thumbnail.toDataURL()
  }));
});

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    const [existingWindow] = BrowserWindow.getAllWindows();
    if (!existingWindow) return;
    if (existingWindow.isMinimized()) existingWindow.restore();
    existingWindow.focus();
  });

  app.whenReady().then(() => {
    void cleanupExpiredTempSounds();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
