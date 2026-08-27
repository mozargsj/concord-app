import { ipcMain, type WebContents } from 'electron';
import path from 'node:path';

// Excludes Concord's own process (and children) from Windows' system-audio loopback capture —
// see native/process-loopback/src/process_loopback.cc for why: without this, screen-share
// system audio picks up whatever Concord itself is playing back through the sharer's speakers
// (every other participant's voice), which comes back out to those same participants as an
// echo of themselves once the screen-audio track reaches them. Windows-only WASAPI feature
// (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, Windows 10 2004+); every caller here treats
// unavailability (wrong platform, addon missing/blocked, activation rejected) as a normal,
// silent signal to fall back to the existing whole-desktop-loopback getUserMedia capture —
// never a hard failure.
type NativeEventType = 'started' | 'error' | 'data' | 'stopped';
type NativeOnEvent = (type: NativeEventType, payload?: string | Buffer) => void;
interface NativeModule {
  start: (excludePid: number, onEvent: NativeOnEvent) => boolean;
  stop: () => void;
}

const START_TIMEOUT_MS = 5000;

let native: NativeModule | null | undefined; // undefined = load not yet attempted this run

function loadNative(): NativeModule | null {
  if (native !== undefined) return native;
  if (process.platform !== 'win32') {
    native = null;
    return native;
  }
  try {
    // Packaged builds: this path is asarUnpack'd (electron-builder.yml) — Electron's fs shim
    // transparently redirects reads of it to app.asar.unpacked, so the same relative path works
    // unpackaged (dev, out/electron/main/index.js) and packaged alike.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binary, not a static import
    native = require(path.join(__dirname, '../../../native/process-loopback/build/Release/process_loopback.node'));
  } catch {
    native = null;
  }
  return native ?? null;
}

let activeWebContents: WebContents | null = null;

ipcMain.handle('process-loopback:start', (event) => {
  const addon = loadNative();
  if (!addon) return Promise.resolve(false);

  activeWebContents = event.sender;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(ok);
    };
    // [Achado, "captura fantasma"] Before this, a timeout only resolved the promise false and
    // never told the addon to stop — if WASAPI's ActivateAudioInterfaceAsync ends up completing
    // AFTER this fires (plausible under system load), the native capture starts for real with
    // nobody left holding a reference that would ever call stop() on it. addon.stop() here is
    // safe to call even if activation never actually started (same call the explicit
    // 'process-loopback:stop' IPC handler already makes unconditionally).
    const timeoutHandle = setTimeout(() => {
      settle(false);
      addon.stop();
    }, START_TIMEOUT_MS);

    addon.start(process.pid, (type, payload) => {
      switch (type) {
        case 'started':
          settle(true);
          return;
        case 'error':
          settle(false);
          return;
        case 'data':
          if (activeWebContents && !activeWebContents.isDestroyed()) {
            activeWebContents.send('process-loopback:chunk', payload);
          }
          return;
        case 'stopped':
          if (activeWebContents && !activeWebContents.isDestroyed()) {
            activeWebContents.send('process-loopback:stopped');
          }
          activeWebContents = null;
      }
    });
  });
});

ipcMain.on('process-loopback:stop', () => {
  loadNative()?.stop();
});

// Cheap, side-effect-free check (just resolves whether require() of the addon succeeds — never
// starts a capture) so the screen-share picker can tell the user up front whether this PC has
// the echo-free path available, instead of only finding out after already sharing.
ipcMain.handle('process-loopback:is-available', () => loadNative() !== null);
