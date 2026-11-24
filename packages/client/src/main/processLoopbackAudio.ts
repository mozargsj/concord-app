import { ipcMain, type WebContents } from 'electron';
import path from 'node:path';

// Bridges the native WASAPI process-loopback addon (native/process-loopback/src/process_loopback.cc)
// into IPC. Two independent uses share this same native module, each its own session:
//   - EXCLUDE-self, during screen share: strips Concord's own playback (every other
//     participant's voice) out of system-audio capture, so remote peers never hear an echo of
//     themselves — the original reason this addon exists.
//   - INCLUDE-one-app, for "share this app's audio" (2026-08-30, pedido do Mozar): captures only
//     the chosen process's audio, nothing else on the system.
// Windows-only WASAPI feature (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, Windows 10 2004+);
// every caller here treats unavailability (wrong platform, addon missing/blocked, activation
// rejected) as a normal, silent signal — never a hard failure. Screen-share system audio falls
// back to the existing whole-desktop-loopback getUserMedia capture; app-audio sharing has no
// fallback (there's nothing to fall back to — it's the only way to isolate one app's audio).
type NativeEventType = 'started' | 'error' | 'data' | 'stopped';
type NativeOnEvent = (type: NativeEventType, payload?: string | Buffer) => void;
type LoopbackMode = 'exclude' | 'include';
interface NativeModule {
  start: (sessionId: string, mode: LoopbackMode, targetPid: number, onEvent: NativeOnEvent) => boolean;
  stop: (sessionId: string) => void;
  listAudioSessions: () => Array<{ pid: number; name: string; exe: string; ancestors: number[] }>;
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

const activeWebContentsBySession = new Map<string, WebContents>();

ipcMain.handle('process-loopback:start', (event, sessionId: string, mode: LoopbackMode, targetPid: number) => {
  const addon = loadNative();
  if (!addon) return Promise.resolve(false);

  // EXCLUDE mode always targets Concord's own process tree — the main process's own pid is the
  // root of that tree (it spawns every renderer/GPU/utility child), and it's the one value the
  // renderer has no reliable way to know about itself, so it's resolved here rather than trusted
  // from the IPC call. INCLUDE mode (share one chosen app's audio) genuinely needs a
  // renderer-supplied pid — whatever the user picked in the audio-session list.
  const resolvedTargetPid = mode === 'exclude' ? process.pid : targetPid;

  activeWebContentsBySession.set(sessionId, event.sender);

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
      addon.stop(sessionId);
    }, START_TIMEOUT_MS);

    let started: boolean;
    try {
      started = addon.start(sessionId, mode, resolvedTargetPid, (type, payload) => {
        switch (type) {
          case 'started':
            settle(true);
            return;
          case 'error':
            settle(false);
            return;
          case 'data': {
            const webContents = activeWebContentsBySession.get(sessionId);
            if (webContents && !webContents.isDestroyed()) {
              webContents.send(`process-loopback:chunk:${sessionId}`, payload);
            }
            return;
          }
          case 'stopped': {
            const webContents = activeWebContentsBySession.get(sessionId);
            if (webContents && !webContents.isDestroyed()) {
              webContents.send(`process-loopback:stopped:${sessionId}`);
            }
            activeWebContentsBySession.delete(sessionId);
          }
        }
      });
    } catch {
      // Session id already capturing (shouldn't happen — the renderer always stops its previous
      // session first) — treat exactly like a normal start failure instead of throwing across IPC.
      started = false;
    }
    if (!started) settle(false);
  });
});

ipcMain.on('process-loopback:stop', (_event, sessionId: string) => {
  loadNative()?.stop(sessionId);
});

// Cheap, side-effect-free check (just resolves whether require() of the addon succeeds — never
// starts a capture) so the screen-share picker can tell the user up front whether this PC has
// the echo-free path available, instead of only finding out after already sharing.
ipcMain.handle('process-loopback:is-available', () => loadNative() !== null);

// Source list for the "share this app's audio" picker — processes with an active render session
// right now (apps that are actually making sound), excluding Concord's own process.
ipcMain.handle('process-loopback:list-audio-sessions', () => loadNative()?.listAudioSessions() ?? []);
