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
  if (kind === 'audiooutput') {
    for (const listener of outputDeviceListeners) listener(deviceId);
  }
}

const outputDeviceListeners = new Set<(deviceId: string) => void>();

/** setSinkId is per-<video>/<audio> element, not global — mounted MediaStreamVideo instances subscribe to react to a preference change without prop-drilling. */
export function onOutputDeviceChange(listener: (deviceId: string) => void): () => void {
  outputDeviceListeners.add(listener);
  return () => outputDeviceListeners.delete(listener);
}
