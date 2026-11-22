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

// Same storage pattern — the last frame-rate choice for screen share. Pedido do Mozar (2026-11-22):
// the capture is always capped at 1080p and the only choice left is 30 or 60 fps (replaced the old
// "Qualidade"/"Fluidez" pair). It also picks RTCRtpSendParameters.degradationPreference in
// webrtcMesh.ts: 60 -> 'maintain-framerate' (keeps the fps when bandwidth drops), 30 ->
// 'maintain-resolution' (keeps the sharpness).
export type ScreenFrameRate = 30 | 60;
const FRAME_RATE_STORAGE_KEY = 'concord.screenShare.frameRate';

// Default 60 ("fixe em 1080p60"); 30 is the lighter option for a PC whose game loses fps.
export function getScreenFrameRate(): ScreenFrameRate {
  return localStorage.getItem(FRAME_RATE_STORAGE_KEY) === '30' ? 30 : 60;
}

export function setScreenFrameRate(frameRate: ScreenFrameRate): void {
  localStorage.setItem(FRAME_RATE_STORAGE_KEY, String(frameRate));
}
