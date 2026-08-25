const STORAGE_KEY = 'concord.audio.masterVolume';

export const MASTER_VOLUME_MIN = 0;
export const MASTER_VOLUME_MAX = 100;
export const MASTER_VOLUME_DEFAULT = 100;

export function getMasterVolume(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : MASTER_VOLUME_DEFAULT;
}

const listeners = new Set<(value: number) => void>();

export function setMasterVolume(value: number): void {
  localStorage.setItem(STORAGE_KEY, String(value));
  for (const listener of listeners) listener(value);
}

/** RoomView applies this to every remote peer's playback volume — subscribes instead of taking
 * a prop, since the setting lives in SettingsModal (opened from UserPanel), decoupled from
 * wherever a room happens to be rendered. Same pub/sub shape as devicePreferences.ts's
 * onOutputDeviceChange. */
export function onMasterVolumeChange(listener: (value: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
