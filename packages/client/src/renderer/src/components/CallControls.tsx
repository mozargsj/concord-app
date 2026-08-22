import { useState } from 'react';
import micIcon from '../assets/icons/mic.svg';
import micOffIcon from '../assets/icons/mic-off.svg';
import cameraIcon from '../assets/icons/camera.svg';
import cameraOffIcon from '../assets/icons/camera-off.svg';
import chevronDownIcon from '../assets/icons/chevron-down.svg';
import screenShareIcon from '../assets/icons/screen-share.svg';
import moreIcon from '../assets/icons/more-horizontal.svg';
import hangupIcon from '../assets/icons/phone-hangup.svg';
import DeviceMenu from './DeviceMenu';
import '../styles/CallControls.css';

interface CallControlsProps {
  isMicMuted: boolean;
  onToggleMic: () => void;
  isCameraOn: boolean;
  onToggleCamera: () => void;
  onSelectCamera: (deviceId: string) => void;
  isSharingScreen: boolean;
  onToggleScreenShare: () => void;
  onLeave: () => void;
}

export default function CallControls({
  isMicMuted,
  onToggleMic,
  isCameraOn,
  onToggleCamera,
  onSelectCamera,
  isSharingScreen,
  onToggleScreenShare,
  onLeave
}: CallControlsProps) {
  const [openMenu, setOpenMenu] = useState<'mic' | 'camera' | null>(null);

  return (
    <div className="call-controls">
      <div className="call-controls__group">
        <button
          className={'call-controls__button' + (isMicMuted ? ' call-controls__button--muted' : '')}
          title={isMicMuted ? 'Ativar microfone' : 'Mutar microfone'}
          onClick={onToggleMic}
        >
          <img src={isMicMuted ? micOffIcon : micIcon} alt="" />
        </button>
        <div className="call-controls__chevron-wrap">
          <button
            className="call-controls__chevron"
            title="Escolher microfone"
            onClick={() => setOpenMenu((prev) => (prev === 'mic' ? null : 'mic'))}
          >
            <img src={chevronDownIcon} alt="" />
          </button>
          {openMenu === 'mic' && (
            <DeviceMenu kind="audioinput" onSelect={() => {}} onClose={() => setOpenMenu(null)} />
          )}
        </div>

        <button
          className={'call-controls__button' + (isCameraOn ? '' : ' call-controls__button--off')}
          title={isCameraOn ? 'Desligar câmera' : 'Ligar câmera'}
          onClick={onToggleCamera}
        >
          <img src={isCameraOn ? cameraIcon : cameraOffIcon} alt="" />
        </button>
        <div className="call-controls__chevron-wrap">
          <button
            className="call-controls__chevron"
            title="Escolher câmera"
            onClick={() => setOpenMenu((prev) => (prev === 'camera' ? null : 'camera'))}
          >
            <img src={chevronDownIcon} alt="" />
          </button>
          {openMenu === 'camera' && (
            <DeviceMenu kind="videoinput" onSelect={onSelectCamera} onClose={() => setOpenMenu(null)} />
          )}
        </div>
      </div>

      <div className="call-controls__group">
        <button
          className={
            'call-controls__button' + (isSharingScreen ? ' call-controls__button--accent' : '')
          }
          title={isSharingScreen ? 'Parar transmissão' : 'Transmitir tela'}
          onClick={onToggleScreenShare}
        >
          <img src={screenShareIcon} alt="" />
        </button>
        <button className="call-controls__button" title="Mais opções">
          <img src={moreIcon} alt="" />
        </button>
      </div>

      <button className="call-controls__hangup" title="Sair da chamada" onClick={onLeave}>
        <img src={hangupIcon} alt="" />
      </button>
    </div>
  );
}
