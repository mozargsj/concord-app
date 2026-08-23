import 'dotenv/config';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage } from 'electron';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loginWithGoogle } from './googleAuth';
import { checkForUpdatesOnStartup } from './autoUpdate';

const sessionFilePath = () => path.join(app.getPath('userData'), 'session.enc');

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

const isDev = !app.isPackaged;

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
