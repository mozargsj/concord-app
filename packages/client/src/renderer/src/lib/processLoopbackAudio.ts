// Bridges the main-process native loopback capture (process_loopback.cc — Windows-only WASAPI
// capture, either excluding one process from the mix or including only it) into a real
// MediaStreamTrack, so callers can treat it exactly like a getUserMedia-produced track. Returns
// null whenever the native path isn't available — wrong platform, addon missing, blocked by an
// OS security policy, activation rejected by an older Windows build, or (INCLUDE mode) the
// target process already closed — so callers fall back accordingly (screen-share system audio
// falls back to the legacy whole-desktop capture; app-audio sharing has no fallback, there's
// nothing else that can isolate one app's audio).
import { pidsToCapture } from '../../../common/appAudioMix';
import type { AudioSession } from '../types/window';

const SAMPLE_RATE = 48000;
const CHANNEL_COUNT = 2;
// Small scheduling lookahead so the very first buffer doesn't get clipped by AudioContext
// startup latency, and a resync cushion for if delivery ever falls behind real-time.
const SCHEDULING_LOOKAHEAD_SECONDS = 0.05;

export interface LoopbackAudioSession {
  track: MediaStreamTrack;
  stop: () => void;
}

/** sessionId namespaces this capture from any other one running at the same time (screen-share
 * system audio and an app-audio share can both be active together) — each gets its own IPC event
 * channel on the main-process side. mode/targetPid map straight to the native addon's WASAPI
 * process-loopback activation: 'exclude' captures everything except targetPid (used with your
 * own pid, for screen-share system audio), 'include' captures only targetPid (used with a chosen
 * app's pid, for "compartilhar áudio"). */
export async function startProcessLoopbackAudio(
  sessionId: string,
  mode: 'exclude' | 'include',
  targetPid: number
): Promise<LoopbackAudioSession | null> {
  if (!window.concord?.processLoopback) return null;

  let started = false;
  try {
    started = await window.concord.processLoopback.start(sessionId, mode, targetPid);
  } catch {
    started = false;
  }
  if (!started) return null;

  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const destination = audioContext.createMediaStreamDestination();
  const unsubscribeChunk = pipeChunksInto(sessionId, audioContext, destination);

  const track = destination.stream.getAudioTracks()[0];

  const unsubscribeStopped = window.concord.processLoopback.onStopped(sessionId, () => {
    // Native capture ended on its own (e.g. an unexpected WASAPI error mid-session, or — INCLUDE
    // mode specifically — the target process exited). track.stop() fires the standard 'ended'
    // event on the track — callers already listen for that on their own tracks (e.g.
    // ServerListPage.tsx's videoTrack.onended for "shared window closed") to detect this exact
    // kind of unexpected stop and update their own UI/state, so this reuses that same signal
    // instead of a bespoke one. Safe to call even if the caller's own stop() below runs right
    // after — MediaStreamTrack.stop() on an already-stopped track is a no-op.
    track.stop();
  });

  const stop = () => {
    unsubscribeChunk();
    unsubscribeStopped();
    window.concord.processLoopback.stop(sessionId);
    track.stop();
    void audioContext.close();
  };

  return { track, stop };
}

/** Schedules every PCM chunk of one native capture into `destination`, back to back. Several
 * captures can feed the same destination — Web Audio sums them (the "only apps" mix below). */
function pipeChunksInto(
  sessionId: string,
  audioContext: AudioContext,
  destination: MediaStreamAudioDestinationNode
): () => void {
  let nextStartTime = audioContext.currentTime + SCHEDULING_LOOKAHEAD_SECONDS;
  return window.concord.processLoopback.onChunk(sessionId, (chunk) => {
    const floats = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / Float32Array.BYTES_PER_ELEMENT);
    const frameCount = Math.floor(floats.length / CHANNEL_COUNT);
    if (frameCount === 0) return;

    const buffer = audioContext.createBuffer(CHANNEL_COUNT, frameCount, SAMPLE_RATE);
    for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let frame = 0; frame < frameCount; frame++) {
        channelData[frame] = floats[frame * CHANNEL_COUNT + channel];
      }
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);

    // If delivery ever falls behind real-time (a GC pause, a slow IPC tick), scheduling the next
    // buffer in the past would throw — resync a little ahead of "now" instead of trying to catch
    // up sample-for-sample, at the cost of a small, inaudible gap.
    const now = audioContext.currentTime;
    if (nextStartTime < now) nextStartTime = now + SCHEDULING_LOOKAHEAD_SECONDS;
    source.start(nextStartTime);
    nextStartTime += buffer.duration;
  });
}

// Same cadence as the "share an app's audio" picker: an app that starts playing mid-share joins
// the mix within this delay (WASAPI only lists a session while it's actually playing).
const APPS_MIX_REFRESH_MS = 1500;

/** Screen-share system audio when the user excluded some apps: one INCLUDE capture per app that
 * is playing and not excluded (common/appAudioMix.ts picks them), all summed into one track,
 * re-evaluated every APPS_MIX_REFRESH_MS. Concord's own process tree never shows up in the session
 * list (process_loopback.cc), so the call's voices stay out like in the EXCLUDE path. Sound that
 * belongs to no app process (Windows system sounds, "Ouvir este dispositivo") stays out too.
 * null when the native addon isn't available. */
export async function startAppsOnlyLoopbackAudio(excludedExes: string[]): Promise<LoopbackAudioSession | null> {
  if (!window.concord?.processLoopback || !(await window.concord.processLoopback.isAvailable().catch(() => false))) {
    return null;
  }

  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const destination = audioContext.createMediaStreamDestination();
  const track = destination.stream.getAudioTracks()[0];
  const captures = new Map<number, () => void>(); // pid -> stop
  const starting = new Set<number>();
  let attempt = 0;
  let stopped = false;

  const startCapture = async (pid: number) => {
    // Fresh id per attempt: a just-stopped capture of the same pid may still be winding down in
    // the addon, and reusing its id would be refused as "already capturing".
    const sessionId = `screen-app-${pid}-${++attempt}`;
    starting.add(pid);
    const ok = await window.concord.processLoopback.start(sessionId, 'include', pid).catch(() => false);
    starting.delete(pid);
    if (!ok) return; // retried on the next refresh while the app is still playing
    if (stopped) {
      window.concord.processLoopback.stop(sessionId);
      return;
    }
    const unsubscribeChunk = pipeChunksInto(sessionId, audioContext, destination);
    const unsubscribeStopped = window.concord.processLoopback.onStopped(sessionId, () => {
      unsubscribeChunk();
      unsubscribeStopped();
      captures.delete(pid); // the app exited or its stream died
    });
    captures.set(pid, () => {
      unsubscribeChunk();
      unsubscribeStopped();
      window.concord.processLoopback.stop(sessionId);
    });
  };

  const refresh = async () => {
    const wanted = new Set(pidsToCapture(await listAudioSessions(), excludedExes));
    if (stopped) return;
    for (const [pid, stopCapture] of captures) {
      if (!wanted.has(pid)) {
        stopCapture();
        captures.delete(pid);
      }
    }
    await Promise.all(
      [...wanted].filter((pid) => !captures.has(pid) && !starting.has(pid)).map((pid) => startCapture(pid))
    );
  };

  await refresh();
  const interval = setInterval(() => void refresh(), APPS_MIX_REFRESH_MS);

  const stop = () => {
    stopped = true;
    clearInterval(interval);
    captures.forEach((stopCapture) => stopCapture());
    captures.clear();
    track.stop();
    void audioContext.close();
  };

  return { track, stop };
}

/** Own process, EXCLUDE mode — screen-share system audio, unchanged behavior/call shape from
 * before this file supported multiple concurrent sessions (2026-08-30). Kept as a thin wrapper
 * so ServerListPage.tsx's existing call site didn't need to know about session ids. The main
 * process resolves the real target pid itself for 'exclude' mode (its own process tree root) —
 * the 0 here is never actually used, see processLoopbackAudio.ts (main). */
export function startExcludedLoopbackAudio(): Promise<LoopbackAudioSession | null> {
  return startProcessLoopbackAudio('screen-system-audio', 'exclude', 0);
}

/** Apps with an active audio session right now, for the "share this app's audio" picker —
 * excludes Concord's own process (see the native addon). Empty array (not null) whenever the
 * native path isn't available, so a caller can render "no apps found" the same way whether
 * that's really true or the platform/addon just doesn't support this. */
export function listAudioSessions(): Promise<AudioSession[]> {
  if (!window.concord?.processLoopback) return Promise.resolve([]);
  return window.concord.processLoopback.listAudioSessions();
}
