import { autoUpdater } from 'electron-updater';
import type { BrowserWindow } from 'electron';

export type UpdateStatus = 'checking' | 'updating' | 'done';
export type UpdatePhase = 'checking' | 'available' | 'downloading' | 'installing';

export interface UpdateStatusInfo {
  status: UpdateStatus;
  phase?: UpdatePhase;
  percent?: number;
  version?: string;
}

// [Bug corrigido] quitAndInstall() fecha a janela internamente pra poder sair do processo, o que
// dispara o mesmo evento 'close' que o botão de fechar/Alt+F4 usam — e main/index.ts sempre pedia
// confirmação nesse evento, sem diferenciar "o usuário está fechando" de "o update está se
// instalando sozinho". Resultado: o update silencioso deixava de ser silencioso, mostrando "Tem
// certeza que deseja fechar?" bem no meio de uma instalação automática. index.ts checa essa flag
// antes de pedir confirmação — só entra em `true` logo antes do quitAndInstall(), então continua
// pedindo confirmação normalmente pra qualquer fechamento de verdade iniciado pelo usuário.
let installingUpdate = false;

export function isInstallingUpdate(): boolean {
  return installingUpdate;
}

/**
 * Checks for an update on every launch and installs it silently, no prompt — the renderer shows
 * a dynamic message/progress bar while it happens (see App.tsx's onUpdateStatus), driven by the
 * real phase/percent below instead of one static "sendo atualizado" screen with no information.
 * Only meaningful in a packaged build; electron-updater has no feed/version metadata in dev, so
 * dev just reports 'done' immediately and the normal boot flow continues.
 */
export function checkForUpdatesOnStartup(window: BrowserWindow, isDev: boolean): void {
  const send = (info: UpdateStatusInfo) => {
    if (!window.isDestroyed()) window.webContents.send('app:update-status', info);
  };

  if (isDev) {
    send({ status: 'done' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  send({ status: 'checking', phase: 'checking' });

  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdate] update-available', info);
    send({ status: 'updating', phase: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[autoUpdate] update-not-available', info);
    send({ status: 'done' });
  });
  autoUpdater.on('error', (err) => {
    console.error('[autoUpdate] error', err);
    send({ status: 'done' });
  });
  autoUpdater.on('download-progress', (progress) => {
    console.log('[autoUpdate] download-progress', progress.percent);
    send({ status: 'updating', phase: 'downloading', percent: Math.round(progress.percent) });
  });
  // quitAndInstall()'s isSilent param defaults to FALSE (confirmed by testing — the doc comment
  // this replaced had it backwards) — without explicitly passing true, the downloaded NSIS
  // installer runs its full GUI wizard instead of applying silently, contradicting the whole
  // point of an unattended background update. isForceRunAfter=true relaunches Concord after.
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[autoUpdate] update-downloaded', info);
    send({ status: 'updating', phase: 'installing', version: info.version });
    installingUpdate = true;
    autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[autoUpdate] checkForUpdates rejected', err);
    send({ status: 'done' });
  });
}
