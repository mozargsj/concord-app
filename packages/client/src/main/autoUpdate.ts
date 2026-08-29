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
 * Shared by both entry points below — the actual check/download/install sequence is identical
 * whether it's the automatic boot-time check or a check the user just explicitly authorized by
 * clicking the update icon (TitleBar.tsx) after a server push (decisions.md — never auto-installs
 * on its own while the app is already open, only at boot). Only meaningful in a packaged build;
 * electron-updater has no feed/version metadata in dev, so dev just reports 'done' immediately.
 */
function runUpdateCheck(window: BrowserWindow, isDev: boolean): void {
  const send = (info: UpdateStatusInfo) => {
    if (!window.isDestroyed()) window.webContents.send('app:update-status', info);
  };

  if (isDev) {
    send({ status: 'done' });
    return;
  }

  // [Achado] did-finish-load can fire more than once (index.ts uses .on(), not .once(), on
  // purpose — see its own comment, for Vite full-reloads in dev). Without this, every call here
  // stacked a fresh set of listeners onto this module-level autoUpdater singleton instead of
  // replacing them, so a real 'update-downloaded' would fire quitAndInstall() once per accumulated
  // registration. Scoped to just the events registered below (not a bare removeAllListeners()) so
  // this never touches any listener electron-updater itself might register on its own emitter.
  for (const event of ['update-available', 'update-not-available', 'error', 'download-progress', 'update-downloaded'] as const) {
    autoUpdater.removeAllListeners(event);
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

/** Automatic, unattended — runs once per launch (main/index.ts's did-finish-load). The renderer
 * shows a blocking full-screen progress state while this runs (App.tsx), since it happens before
 * the user has done anything else in the session yet. */
export function checkForUpdatesOnStartup(window: BrowserWindow, isDev: boolean): void {
  runUpdateCheck(window, isDev);
}

/** User-authorized — triggered only after the renderer's TitleBar shows the update-available icon
 * (pushed via the server's UpdatesBroadcaster while the app was already open, see
 * lib/updateNotifications.ts) and the user explicitly clicks it. Same underlying check/download/
 * install sequence as the startup one; the renderer is responsible for the "are you sure, this
 * restarts the app" confirmation before ever calling this (see app:start-update in index.ts). */
export function checkForUpdatesOnDemand(window: BrowserWindow, isDev: boolean): void {
  runUpdateCheck(window, isDev);
}
