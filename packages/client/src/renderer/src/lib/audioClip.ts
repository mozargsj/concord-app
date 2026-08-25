// Decode/trim/encode pipeline for the soundboard's "Enviar um som" flow — no format-conversion
// library involved anywhere here (per decisions.md): decoding relies entirely on whatever
// Chromium's decodeAudioData already supports, and the only encoder is a hand-rolled PCM16 WAV
// writer, since the trim step (OfflineAudioContext) only ever produces raw PCM samples back.

let sharedContext: AudioContext | null = null;

function getContext(): AudioContext {
  if (!sharedContext) sharedContext = new AudioContext();
  return sharedContext;
}

/** One shared AudioContext for decode + local preview playback — avoids piling up a fresh
 * context (and its warm-up cost) per preview click. */
export function getSharedAudioContext(): AudioContext {
  return getContext();
}

/** decodeAudioData detaches the buffer it's given — sliced so callers can still use the
 * original ArrayBuffer afterwards if they need to. */
export async function decodeAudioFile(data: ArrayBuffer): Promise<AudioBuffer> {
  return getContext().decodeAudioData(data.slice(0));
}

/** Renders just the [startSec, endSec) window of `buffer` into a fresh AudioBuffer — the actual
 * 15s-max cut applied by the waveform trimmer before anything is saved. */
export async function renderTrimmedClip(buffer: AudioBuffer, startSec: number, endSec: number): Promise<AudioBuffer> {
  const duration = Math.max(0, endSec - startSec);
  const frameCount = Math.max(1, Math.round(duration * buffer.sampleRate));
  const offlineContext = new OfflineAudioContext(buffer.numberOfChannels, frameCount, buffer.sampleRate);
  const source = offlineContext.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineContext.destination);
  source.start(0, startSec, duration);
  return offlineContext.startRendering();
}

/** Minimal PCM16 WAV encoder — the only "conversion" this feature does, and it's a plain
 * container write (uncompressed samples + a 44-byte header), not a codec. */
export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const blockAlign = numChannels * 2;
  const dataSize = numFrames * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  function writeString(offset: number, text: string): void {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < numChannels; channel++) channelData.push(buffer.getChannelData(channel));

  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return out;
}

export const WAV_MIME_TYPE = 'audio/wav';
