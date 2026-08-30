const STORAGE_KEY = 'concord.audio.micGain';

export const MIC_GAIN_MIN = 0;
export const MIC_GAIN_MAX = 200;
export const MIC_GAIN_DEFAULT = 100;

export function getMicGain(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : MIC_GAIN_DEFAULT;
}

const listeners = new Set<(value: number) => void>();

export function setMicGain(value: number): void {
  localStorage.setItem(STORAGE_KEY, String(value));
  for (const listener of listeners) listener(value);
}

/** lib/noiseGate.ts subscribes to this directly (not via React props) so dragging the slider
 * mid-call updates the live gain immediately — same "module-level pub/sub for a local preference"
 * pattern as micSensitivity.ts's onMicSensitivityChange. */
export function onMicGainChange(listener: (value: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 100% = unity gain (no change, today's default behavior) — 0-100% attenuates like a normal
 * volume knob, 100-200% boosts beyond the mic's natural level for someone who's just quiet. */
export function micGainToMultiplier(gainPercent: number): number {
  return gainPercent / 100;
}
