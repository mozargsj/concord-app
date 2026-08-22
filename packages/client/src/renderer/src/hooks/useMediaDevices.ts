import { useEffect, useState } from 'react';
import type { DeviceKind } from '../lib/devicePreferences';

export interface DeviceOption {
  deviceId: string;
  label: string;
}

/**
 * Labels come back empty until a getUserMedia permission has been granted at
 * least once for that media kind — falls back to "Dispositivo N" so the menu
 * is still usable before that happens.
 */
export function useMediaDevices(kind: DeviceKind): DeviceOption[] {
  const [devices, setDevices] = useState<DeviceOption[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const all = await navigator.mediaDevices.enumerateDevices();
      const filtered = all
        .filter((device) => device.kind === kind)
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Dispositivo ${index + 1}`
        }));
      if (!cancelled) setDevices(filtered);
    }

    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
    };
  }, [kind]);

  return devices;
}
