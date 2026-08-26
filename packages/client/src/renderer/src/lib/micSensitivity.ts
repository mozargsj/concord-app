const STORAGE_KEY = 'concord.audio.micSensitivity';

export const MIC_SENSITIVITY_MIN = 0;
export const MIC_SENSITIVITY_MAX = 100;
export const MIC_SENSITIVITY_DEFAULT = 50;

export function getMicSensitivity(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : MIC_SENSITIVITY_DEFAULT;
}

const listeners = new Set<(value: number) => void>();

export function setMicSensitivity(value: number): void {
  localStorage.setItem(STORAGE_KEY, String(value));
  for (const listener of listeners) listener(value);
}

/** lib/noiseGate.ts subscribes to this directly (not via React props) so dragging the slider
 * mid-call updates the live gate immediately, same "module-level pub/sub for a local preference"
 * pattern as devicePreferences.ts's onOutputDeviceChange. */
export function onMicSensitivityChange(listener: (value: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * No universal fixed noise-gate threshold exists in the literature — energy/room-noise varies too
 * much per mic/room, every source (podcast noise-gate guides, VAD research) converges on "make it
 * user-adjustable, calibrated to the room" instead of a fixed number. This maps the 0-100 slider
 * onto a -60dB..-30dB range, informed by real-world reference points: -35dB cited as an "effective,
 * safe" noise-gate threshold for voice (permissive — favors not clipping real speech), some
 * hardware setups run as high as -20dB (aggressive), Discord's own manual input-sensitivity slider
 * (dBFS) sits in this same neighborhood. Direction matches the slider's existing meaning here (see
 * SettingsModal.tsx's hint, "abaixo da linha, o microfone é silenciado" — the value IS the line):
 * higher slider value = higher (louder-required) threshold = cuts more; 0=-60dB (barely cuts
 * anything), 100=-30dB (needs a loud voice), 50 (default)=-45dB.
 */
export function sensitivityToThresholdDb(sensitivity: number): number {
  return -60 + (sensitivity / 100) * 30;
}

export function sensitivityToThresholdRms(sensitivity: number): number {
  return Math.pow(10, sensitivityToThresholdDb(sensitivity) / 20);
}
