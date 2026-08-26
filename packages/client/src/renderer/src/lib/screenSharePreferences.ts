// Local-only preference, same storage pattern as noiseSuppressionSettings.ts — remembers whether
// the last screen share had "Incluir áudio do sistema" checked, so the picker doesn't reset back
// to the same default every time regardless of what the user actually chose last.
const STORAGE_KEY = 'concord.screenShare.includeAudio';

// Default off (unchecked) the very first time, before any choice has ever been made — matches
// the picker's previous fixed behavior, doesn't opt a new user into system-audio capture without
// them ever having asked for it.
export function getIncludeAudioPreference(): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? false : raw === 'true';
}

export function setIncludeAudioPreference(value: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(value));
}
