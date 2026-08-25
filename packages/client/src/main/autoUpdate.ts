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

  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdate] update-available', info);
    send('updating');
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[autoUpdate] update-not-available', info);
    send('done');
  });
  autoUpdater.on('error', (err) => {
    console.error('[autoUpdate] error', err);
    send('done');
  });
  autoUpdater.on('download-progress', (progress) => {
    console.log('[autoUpdate] download-progress', progress.percent);
  });
  // quitAndInstall()'s isSilent param defaults to FALSE (confirmed by testing — the doc comment
  // this replaced had it backwards) — without explicitly passing true, the downloaded NSIS
  // installer runs its full GUI wizard instead of applying silently, contradicting the whole
  // point of an unattended background update. isForceRunAfter=true relaunches Concord after.
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[autoUpdate] update-downloaded', info);
    autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[autoUpdate] checkForUpdates rejected', err);
    send('done');
  });
}
