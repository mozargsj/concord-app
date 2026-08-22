const STORAGE_KEY = 'concord.audio.micSensitivity';

export const MIC_SENSITIVITY_MIN = 0;
export const MIC_SENSITIVITY_MAX = 100;
export const MIC_SENSITIVITY_DEFAULT = 50;

export function getMicSensitivity(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : MIC_SENSITIVITY_DEFAULT;
}

export function setMicSensitivity(value: number): void {
  localStorage.setItem(STORAGE_KEY, String(value));
}
