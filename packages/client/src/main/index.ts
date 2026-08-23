import 'dotenv/config';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage } from 'electron';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loginWithGoogle } from './googleAuth';

const sessionFilePath = () => path.join(app.getPath('userData'), 'session.enc');

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

const isDev = !app.isPackaged;

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.on('maximize', () => window.webContents.send('window:maximized-change', true));
  window.on('unmaximize', () => window.webContents.send('window:maximized-change', false));

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
