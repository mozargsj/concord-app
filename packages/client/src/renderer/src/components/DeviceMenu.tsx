import { useMediaDevices } from '../hooks/useMediaDevices';
import type { DeviceKind } from '../lib/devicePreferences';
import { getPreferredDeviceId, setPreferredDeviceId } from '../lib/devicePreferences';
import '../styles/DeviceMenu.css';

interface DeviceMenuProps {
  kind: DeviceKind;
  onSelect: (deviceId: string) => void;
  onClose: () => void;
  align?: 'left' | 'right';
}

export default function DeviceMenu({ kind, onSelect, onClose, align = 'left' }: DeviceMenuProps) {
  const devices = useMediaDevices(kind);
  const selectedId = getPreferredDeviceId(kind);

  function handlePick(deviceId: string) {
    setPreferredDeviceId(kind, deviceId);
    onSelect(deviceId);
    onClose();
  }

  return (
    <>
      <div className="device-menu__backdrop" onClick={onClose} />
      <div className={'device-menu device-menu--' + align}>
        {devices.length === 0 && <div className="device-menu__empty">Nenhum dispositivo encontrado</div>}
        {devices.map((device) => (
          <button
            key={device.deviceId}
            className={
              'device-menu__item' + (device.deviceId === selectedId ? ' device-menu__item--selected' : '')
            }
            onClick={() => handlePick(device.deviceId)}
          >
            {device.label}
          </button>
        ))}
      </div>
    </>
  );
}
