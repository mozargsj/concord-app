// Bridges the main-process native loopback capture (process_loopback.cc — Windows-only WASAPI
// capture, either excluding one process from the mix or including only it) into a real
// MediaStreamTrack, so callers can treat it exactly like a getUserMedia-produced track. Returns
// null whenever the native path isn't available — wrong platform, addon missing, blocked by an
// OS security policy, activation rejected by an older Windows build, or (INCLUDE mode) the
// target process already closed — so callers fall back accordingly (screen-share system audio
// falls back to the legacy whole-desktop capture; app-audio sharing has no fallback, there's
// nothing else that can isolate one app's audio).
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
  let nextStartTime = audioContext.currentTime + SCHEDULING_LOOKAHEAD_SECONDS;

  const unsubscribeChunk = window.concord.processLoopback.onChunk(sessionId, (chunk) => {
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
export function listAudioSessions(): Promise<Array<{ pid: number; name: string }>> {
  if (!window.concord?.processLoopback) return Promise.resolve([]);
  return window.concord.processLoopback.listAudioSessions();
}
