import { autoUpdater } from 'electron-updater';
import type { BrowserWindow } from 'electron';

export type UpdateStatus = 'checking' | 'updating' | 'done';

/**
 * Checks for an update on every launch and installs it silently, no prompt — the renderer just
 * shows a "sendo atualizado" screen while it happens (see App.tsx's onUpdateStatus). Only
 * meaningful in a packaged build; electron-updater has no feed/version metadata in dev, so dev
 * just reports 'done' immediately and the normal boot flow continues.
 */
export function checkForUpdatesOnStartup(window: BrowserWindow, isDev: boolean): void {
  const send = (status: UpdateStatus) => {
    if (!window.isDestroyed()) window.webContents.send('app:update-status', status);
  };

  if (isDev) {
    send('done');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', () => send('updating'));
  autoUpdater.on('update-not-available', () => send('done'));
  autoUpdater.on('error', () => send('done'));
  // quitAndInstall()'s isSilent defaults to true — installs and relaunches with no installer UI.
  autoUpdater.on('update-downloaded', () => autoUpdater.quitAndInstall());

  autoUpdater.checkForUpdates().catch(() => send('done'));
}
