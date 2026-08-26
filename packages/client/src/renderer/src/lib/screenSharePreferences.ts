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

// Same storage pattern — remembers the last "priorizar qualidade vs. fluidez" choice for screen
// share, so it's a real user decision (pedido do Mozar) instead of a fixed app default. Maps to
// RTCRtpSendParameters.degradationPreference in webrtcMesh.ts: 'quality' -> 'maintain-resolution'
// (keep resolution under bad bandwidth — best for static/text content), 'smoothness' ->
// 'maintain-framerate' (keep fps under bad bandwidth — best for games/interactive content).
export type ScreenQualityMode = 'quality' | 'smoothness';
const QUALITY_MODE_STORAGE_KEY = 'concord.screenShare.qualityMode';

// Default 'quality' — matches the app's original fixed behavior before this became a choice, so
// nobody's experience changes just from this feature shipping.
export function getScreenQualityMode(): ScreenQualityMode {
  const raw = localStorage.getItem(QUALITY_MODE_STORAGE_KEY);
  return raw === 'smoothness' ? 'smoothness' : 'quality';
}

export function setScreenQualityMode(mode: ScreenQualityMode): void {
  localStorage.setItem(QUALITY_MODE_STORAGE_KEY, mode);
}
