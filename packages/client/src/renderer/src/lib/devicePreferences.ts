export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';

const STORAGE_KEYS: Record<DeviceKind, string> = {
  audioinput: 'concord.device.mic',
  audiooutput: 'concord.device.speaker',
  videoinput: 'concord.device.camera'
};

export function getPreferredDeviceId(kind: DeviceKind): string | null {
  return localStorage.getItem(STORAGE_KEYS[kind]);
}

export function setPreferredDeviceId(kind: DeviceKind, deviceId: string): void {
  localStorage.setItem(STORAGE_KEYS[kind], deviceId);
}
