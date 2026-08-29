import { useState } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, Settings, ChevronDown } from 'lucide-react';
import SettingsModal from './SettingsModal';
import DeviceMenu from './DeviceMenu';
import MutedHint from './MutedHint';
import '../styles/UserPanel.css';

interface UserPanelProps {
  isMicMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  showMutedSpeakingHint: boolean;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  onSelectMic: (deviceId: string) => void;
  onSelectSpeaker: (deviceId: string) => void;
  displayName: string;
  avatarUrl: string | null;
  onOpenProfile: () => void;
  onNoiseSuppressionChange: () => void;
}

export default function UserPanel({
  isMicMuted,
  isDeafened,
  isSpeaking,
  showMutedSpeakingHint,
  onToggleMic,
  onToggleDeafen,
  onSelectMic,
  onSelectSpeaker,
  displayName,
  avatarUrl,
  onOpenProfile,
  onNoiseSuppressionChange
}: UserPanelProps) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<'mic' | 'speaker' | null>(null);

  return (
    <div className="user-panel">
      <button className="user-panel__identity" onClick={onOpenProfile} title="Seu perfil">
        <div className={'user-panel__avatar' + (isSpeaking ? ' user-panel__avatar--speaking' : '')}>
          {avatarUrl ? <img src={avatarUrl} alt="" /> : displayName.charAt(0).toUpperCase()}
          <span className="user-panel__online-dot" />
        </div>

        <div className="user-panel__info">
          <span className="user-panel__name">{displayName}</span>
          <span className="user-panel__status">Disponível</span>
        </div>
      </button>

      <div className="user-panel__actions">
        <div className="user-panel__device-group">
          <button
            className={
              'user-panel__device-button' + (isMicMuted ? ' user-panel__device-button--active' : '')
            }
            title={isMicMuted ? 'Ativar microfone' : 'Mutar microfone'}
            onClick={onToggleMic}
          >
            {isMicMuted ? <MicOff size={27} /> : <Mic size={27} />}
          </button>
          <button
            className="user-panel__device-chevron-button"
            title="Escolher microfone"
            onClick={() => setOpenMenu((prev) => (prev === 'mic' ? null : 'mic'))}
          >
            <ChevronDown size={30} className="user-panel__device-chevron" />
          </button>
          {openMenu === 'mic' && (
            <DeviceMenu kind="audioinput" onSelect={onSelectMic} onClose={() => setOpenMenu(null)} />
          )}
          {showMutedSpeakingHint && <MutedHint />}
        </div>

        <div className="user-panel__device-group">
          <button
            className={
              'user-panel__device-button' + (isDeafened ? ' user-panel__device-button--active' : '')
            }
            title={isDeafened ? 'Reativar áudio' : 'Silenciar tudo'}
            onClick={onToggleDeafen}
          >
            {isDeafened ? <HeadphoneOff size={27} /> : <Headphones size={27} />}
          </button>
          <button
            className="user-panel__device-chevron-button"
            title="Escolher saída de áudio"
            onClick={() => setOpenMenu((prev) => (prev === 'speaker' ? null : 'speaker'))}
          >
            <ChevronDown size={30} className="user-panel__device-chevron" />
          </button>
          {openMenu === 'speaker' && (
            // Left-aligned like the mic menu (not right) — this sits in the narrow sidebar,
            // where opening rightward into the spacious main content area never clips against
            // the window edge; opening leftward from a button already near the panel's right
            // side does.
            <DeviceMenu kind="audiooutput" onSelect={onSelectSpeaker} onClose={() => setOpenMenu(null)} />
          )}
        </div>

        <button
          className="user-panel__icon-button"
          title="Configurações"
          onClick={() => setIsSettingsOpen(true)}
        >
          <Settings size={27} />
        </button>
      </div>

      {isSettingsOpen && (
        <SettingsModal onClose={() => setIsSettingsOpen(false)} onNoiseSuppressionChange={onNoiseSuppressionChange} />
      )}
    </div>
  );
}
