import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseWasmSimdPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

// RNNoise assumes 48kHz (package docs) — explicit sampleRate rather than trusting whatever the
// default AudioContext would pick, since getUserMedia's own default can vary by platform.
let sharedContext: AudioContext | null = null;
let workletReadyPromise: Promise<void> | null = null;
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

async function getReadyContext(): Promise<AudioContext> {
  if (!sharedContext) sharedContext = new AudioContext({ sampleRate: 48000 });
  void sharedContext.resume().catch(() => {});
  if (!workletReadyPromise) workletReadyPromise = sharedContext.audioWorklet.addModule(rnnoiseWorkletPath);
  await workletReadyPromise;
  return sharedContext;
}

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseWasmSimdPath });
  }
  return wasmBinaryPromise;
}

export interface DenoisedTrackHandle {
  track: MediaStreamTrack;
  stop: () => void;
}

/**
 * Wraps a raw mic track in an RNNoise AudioWorklet graph and returns a clean track to send
 * instead — the caller treats this exactly like any other MediaStreamTrack (it never needs to
 * know RNNoise is involved). `stop()` tears down just this graph; it does not touch `inputTrack`
 * itself, since the caller owns that (usually stopping the whole getUserMedia stream it came from).
 */
export async function createDenoisedTrack(inputTrack: MediaStreamTrack): Promise<DenoisedTrackHandle> {
  const ctx = await getReadyContext();
  const wasmBinary = await getWasmBinary();

  const source = ctx.createMediaStreamSource(new MediaStream([inputTrack]));
  const rnnoise = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
  const destination = ctx.createMediaStreamDestination();
  source.connect(rnnoise);
  rnnoise.connect(destination);

  const track = destination.stream.getAudioTracks()[0];
  return {
    track,
    stop: () => {
      source.disconnect();
      rnnoise.disconnect();
      rnnoise.destroy();
    }
  };
}
