// Local-only preference, same storage pattern as micSensitivity.ts/soundboardVolume.ts — no
// server round-trip needed to read it back on the next launch.
const STORAGE_KEY = 'concord.audio.rnnoiseEnabled';

/** Default on: the native WebRTC noiseSuppression alone was leaking mouse clicks/keyboard
 * taps in testing, RNNoise (an actual denoising model, not just a gate) does noticeably better. */
export function getRnnoiseEnabled(): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? true : raw === 'true';
}

export function setRnnoiseEnabled(value: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(value));
}
