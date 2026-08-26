// Bridges the main-process native loopback capture (process_loopback.cc — Windows-only WASAPI
// capture that excludes Concord's own audio from the loopback, see that file's header comment
// for the "viewer hears their own echo" bug this fixes) into a real MediaStreamTrack, so the
// rest of the screen-share pipeline (webrtcMesh.ts) can treat it exactly like the track today's
// getUserMedia-based capture produces. Returns null whenever the native path isn't available —
// wrong platform, addon missing, blocked by an OS security policy, activation rejected by an
// older Windows build — so the caller (ServerListPage.tsx) can fall back to that existing path.
const SAMPLE_RATE = 48000;
const CHANNEL_COUNT = 2;
// Small scheduling lookahead so the very first buffer doesn't get clipped by AudioContext
// startup latency, and a resync cushion for if delivery ever falls behind real-time.
const SCHEDULING_LOOKAHEAD_SECONDS = 0.05;

export interface LoopbackAudioSession {
  track: MediaStreamTrack;
  stop: () => void;
}

export async function startExcludedLoopbackAudio(): Promise<LoopbackAudioSession | null> {
  if (!window.concord?.processLoopback) return null;

  let started = false;
  try {
    started = await window.concord.processLoopback.start();
  } catch {
    started = false;
  }
  if (!started) return null;

  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const destination = audioContext.createMediaStreamDestination();
  let nextStartTime = audioContext.currentTime + SCHEDULING_LOOKAHEAD_SECONDS;

  const unsubscribeChunk = window.concord.processLoopback.onChunk((chunk) => {
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

  const unsubscribeStopped = window.concord.processLoopback.onStopped(() => {
    // Native capture ended on its own (e.g. an unexpected WASAPI error mid-session) — the
    // destination's track keeps emitting silence rather than throwing, and stop() below is
    // still safe to call whenever the caller's own screen-share teardown runs.
  });

  const track = destination.stream.getAudioTracks()[0];

  const stop = () => {
    unsubscribeChunk();
    unsubscribeStopped();
    window.concord.processLoopback.stop();
    track.stop();
    void audioContext.close();
  };

  return { track, stop };
}
