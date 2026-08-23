import { useState } from 'react';
import { Mic, MicOff, Video, VideoOff, ChevronDown, ScreenShare, MoreHorizontal, PhoneOff } from 'lucide-react';
import DeviceMenu from './DeviceMenu';
import MutedHint from './MutedHint';
import '../styles/CallControls.css';

interface CallControlsProps {
  isMicMuted: boolean;
  onToggleMic: () => void;
  onSelectMic: (deviceId: string) => void;
  showMutedSpeakingHint: boolean;
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
  onSelectMic,
  showMutedSpeakingHint,
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
        <div className="call-controls__mic-wrap">
          <button
            className={'call-controls__button' + (isMicMuted ? ' call-controls__button--muted' : '')}
            title={isMicMuted ? 'Ativar microfone' : 'Mutar microfone'}
            onClick={onToggleMic}
          >
            {isMicMuted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          {showMutedSpeakingHint && <MutedHint />}
        </div>
        <div className="call-controls__chevron-wrap">
          <button
            className="call-controls__chevron"
            title="Escolher microfone"
            onClick={() => setOpenMenu((prev) => (prev === 'mic' ? null : 'mic'))}
          >
            <ChevronDown size={16} />
          </button>
          {openMenu === 'mic' && (
            <DeviceMenu kind="audioinput" onSelect={onSelectMic} onClose={() => setOpenMenu(null)} />
          )}
        </div>

        <button
          className={'call-controls__button' + (isCameraOn ? '' : ' call-controls__button--off')}
          title={isCameraOn ? 'Desligar câmera' : 'Ligar câmera'}
          onClick={onToggleCamera}
        >
          {isCameraOn ? <Video size={18} /> : <VideoOff size={18} />}
        </button>
        <div className="call-controls__chevron-wrap">
          <button
            className="call-controls__chevron"
            title="Escolher câmera"
            onClick={() => setOpenMenu((prev) => (prev === 'camera' ? null : 'camera'))}
          >
            <ChevronDown size={16} />
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
          <ScreenShare size={18} />
        </button>
        <button className="call-controls__button" title="Mais opções">
          <MoreHorizontal size={18} />
        </button>
      </div>

      <button className="call-controls__hangup" title="Desconectar" onClick={onLeave}>
        <PhoneOff size={18} />
      </button>
    </div>
  );
}
