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

// [Pedido do Mozar, 2026-11-24] Apps whose audio never goes into the screen-share system audio.
// Per Concord account on this PC (the key carries the userId): apps differ from PC to PC, so the
// list doesn't roam. Keyed by exe filename, which survives restarts (a pid doesn't); `name` is
// only what the picker shows for an excluded app that isn't playing right now.
export interface ExcludedAudioApp {
  exe: string;
  name: string;
}
const EXCLUDED_APPS_KEY_PREFIX = 'concord.screenShare.excludedApps.';

// [Pedido do Mozar, 2026-11-24] Excluded out of the box, the user can put any of them back: call
// apps, whose sound is other people's voices, not something to stream. Applies only until the
// user saves a list of their own (any toggle in the picker saves the whole list).
// ponytail: an app added here later doesn't reach users who already saved a list.
export const DEFAULT_EXCLUDED_AUDIO_APPS: ExcludedAudioApp[] = [
  { exe: 'Discord.exe', name: 'Discord' },
  { exe: 'DiscordPTB.exe', name: 'Discord PTB' },
  { exe: 'DiscordCanary.exe', name: 'Discord Canary' },
  { exe: 'TeamSpeak.exe', name: 'TeamSpeak' },
  { exe: 'ts3client_win64.exe', name: 'TeamSpeak 3' },
  { exe: 'mumble.exe', name: 'Mumble' },
  { exe: 'Zoom.exe', name: 'Zoom' },
  { exe: 'ms-teams.exe', name: 'Microsoft Teams' }
];

export function isDefaultExcludedAudioApp(exe: string): boolean {
  return DEFAULT_EXCLUDED_AUDIO_APPS.some((app) => app.exe.toLowerCase() === exe.toLowerCase());
}

export function getExcludedAudioApps(userId: string): ExcludedAudioApp[] {
  const raw = localStorage.getItem(EXCLUDED_APPS_KEY_PREFIX + userId);
  if (raw === null) return [...DEFAULT_EXCLUDED_AUDIO_APPS];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((app): app is ExcludedAudioApp => typeof app?.exe === 'string' && typeof app?.name === 'string')
      : [];
  } catch {
    return [];
  }
}

export function setExcludedAudioApps(userId: string, apps: ExcludedAudioApp[]): void {
  localStorage.setItem(EXCLUDED_APPS_KEY_PREFIX + userId, JSON.stringify(apps));
}
