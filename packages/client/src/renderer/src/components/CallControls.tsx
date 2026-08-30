import { useState } from 'react';
import { Mic, MicOff, Video, VideoOff, ChevronDown, ScreenShare, Music2, PhoneOff, Minimize2 } from 'lucide-react';
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
  isSharingMusic: boolean;
  onToggleMusicShare: () => void;
  onLeave: () => void;
  /** A tile (screen or camera) is currently in fullscreen focus — see RoomView's focusedTileKey.
   * While true, the red button below means "exit that focused view", not "leave the call": it
   * sits in the same place as the tile's own "×"/Esc exit, so it's easy to reach for by habit
   * mid-focus and had actually caused someone to leave the whole room by accident wanting only to
   * stop viewing a transmission. */
  isFocused: boolean;
  onExitFocus: () => void;
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
  isSharingMusic,
  onToggleMusicShare,
  onLeave,
  isFocused,
  onExitFocus
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
        <button
          className={
            'call-controls__button' + (isSharingMusic ? ' call-controls__button--accent' : '')
          }
          title={isSharingMusic ? 'Parar de compartilhar áudio' : 'Compartilhar áudio'}
          onClick={onToggleMusicShare}
        >
          <Music2 size={18} />
        </button>
      </div>

      {isFocused ? (
        <button className="call-controls__hangup" title="Sair da transmissão" onClick={onExitFocus}>
          <Minimize2 size={18} />
        </button>
      ) : (
        <button className="call-controls__hangup" title="Desconectar" onClick={onLeave}>
          <PhoneOff size={18} />
        </button>
      )}
    </div>
  );
}
