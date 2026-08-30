// Fast attack (opens on the very next poll tick, no deliberate delay) — audio-engineering/VAD
// convention: a slow attack clips the start of words, always undesirable for a gate.
// Poll cheap enough to run continuously (same technique as webrtcMesh's local speaking detector —
// synchronous time-domain read off an AnalyserNode, no getStats()).
const GATE_POLL_INTERVAL_MS = 20;
// Release: how long to hold the gate open after dropping below threshold, before actually cutting
// — distinct from VAD "hangover" (200-1000ms, tuned for conversational turn-taking pauses). A
// noise gate's release only needs to survive a trailing consonant/breath within one utterance;
// audio-engineering convention for that is much shorter, commonly 50-300ms. 150ms picked as a
// middle value.
const GATE_RELEASE_MS = 150;
// Smooth ramp on open/close, not an instant jump — avoids an audible click/pop at the gate's own
// transition (standard technique, same reason volume faders use a ramp instead of a step).
const GAIN_RAMP_SECONDS = 0.01;

export interface GatedTrackHandle {
  track: MediaStreamTrack;
  /** Live-updates the threshold without rebuilding the graph — lets the settings slider (or the
   * onMicSensitivityChange subscription) take effect immediately, mid-call. */
  setThresholdRms: (value: number) => void;
  /** Live-updates the boost/attenuation multiplier applied while the gate is open (1 = unity,
   * same as before this existed; 2 = +200%) — same immediate-effect contract as setThresholdRms,
   * lib/micGain.ts's onMicGainChange subscribes to this. Ramped, not stepped, same as the
   * gate's own open/close transitions, so dragging the slider mid-call doesn't click/pop. */
  setGainMultiplier: (value: number) => void;
  stop: () => void;
}

/**
 * Wraps a track (raw mic, or already RNNoise-denoised) in a simple expander/gate: silences the
 * signal below `thresholdRms`, passes it through above it — at `gainMultiplier` instead of a
 * flat 1 (unity), so the same node also doubles as the mic boost/attenuation control
 * (lib/micGain.ts) instead of needing a second GainNode in the chain. This is the "corte
 * automático de ruído" decisions.md had as a UI-only stub (the sensitivity slider saved a value
 * nothing ever read) — this is what actually applies it to the outgoing audio now.
 */
export function createGatedTrack(
  inputTrack: MediaStreamTrack,
  initialThresholdRms: number,
  initialGainMultiplier = 1
): GatedTrackHandle {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(new MediaStream([inputTrack]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const gain = ctx.createGain();
  gain.gain.value = 0; // starts closed — opens on the first tick that's actually above threshold
  const destination = ctx.createMediaStreamDestination();

  // analyser taps the signal for level-reading only; gain is the actual audio path to destination.
  source.connect(analyser);
  source.connect(gain);
  gain.connect(destination);

  let threshold = initialThresholdRms;
  let gainMultiplier = initialGainMultiplier;
  let isOpen = false;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  const samples = new Uint8Array(analyser.fftSize);

  const pollHandle = setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = (samples[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const level = Math.sqrt(sumSquares / samples.length);

    if (level > threshold) {
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      if (!isOpen) {
        isOpen = true;
        gain.gain.setTargetAtTime(gainMultiplier, ctx.currentTime, GAIN_RAMP_SECONDS);
      }
    } else if (isOpen && !releaseTimer) {
      releaseTimer = setTimeout(() => {
        isOpen = false;
        gain.gain.setTargetAtTime(0, ctx.currentTime, GAIN_RAMP_SECONDS);
        releaseTimer = null;
      }, GATE_RELEASE_MS);
    }
  }, GATE_POLL_INTERVAL_MS);

  return {
    track: destination.stream.getAudioTracks()[0],
    setThresholdRms: (value) => {
      threshold = value;
    },
    setGainMultiplier: (value) => {
      gainMultiplier = value;
      if (isOpen) gain.gain.setTargetAtTime(value, ctx.currentTime, GAIN_RAMP_SECONDS);
    },
    stop: () => {
      clearInterval(pollHandle);
      if (releaseTimer) clearTimeout(releaseTimer);
      source.disconnect();
      analyser.disconnect();
      gain.disconnect();
      void ctx.close().catch(() => {});
    }
  };
}
