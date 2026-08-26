// Local-only preference, same storage pattern as noiseSuppressionSettings.ts — whether the
// screen-share video sender should prefer H.264 (the only codec with a real shot at Chromium's
// hardware encoder path on Windows, see webrtcMesh.ts's preferH264ForScreenVideo) over the
// default VP8. Default on: hardware encoding is strictly better when it's actually available
// (lower CPU/battery use, confirmed via getStats() on real NVIDIA hardware), and falls back to
// software H.264/VP8 transparently when it isn't — there's no real downside to leaving it on.
const STORAGE_KEY = 'concord.video.hardwareEncodeEnabled';

export function getHardwareEncodePreference(): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? true : raw === 'true';
}

export function setHardwareEncodePreference(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}
