// General soundboard volume — local-only preference, same storage pattern as micSensitivity.ts.
// This is the "real" volume applied at playback time; the per-sound volume set in the add modal
// is fixed at save time and combines with this one (decisions.md — soundboard section).

const STORAGE_KEY = 'concord.audio.soundboardVolume';

export const SOUNDBOARD_VOLUME_MIN = 0;
export const SOUNDBOARD_VOLUME_MAX = 100;
export const SOUNDBOARD_VOLUME_DEFAULT = 80;

export function getSoundboardVolume(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : SOUNDBOARD_VOLUME_DEFAULT;
}

export function setSoundboardVolume(value: number): void {
  localStorage.setItem(STORAGE_KEY, String(value));
}
