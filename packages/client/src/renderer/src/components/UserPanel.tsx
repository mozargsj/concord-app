import { useState } from 'react';
import micIcon from '../assets/icons/mic.svg';
import micOffIcon from '../assets/icons/mic-off.svg';
import headphonesIcon from '../assets/icons/headphones.svg';
import headphonesOffIcon from '../assets/icons/headphones-off.svg';
import settingsIcon from '../assets/icons/settings.svg';
import chevronDownIcon from '../assets/icons/chevron-down.svg';
import SettingsModal from './SettingsModal';
import DeviceMenu from './DeviceMenu';
import '../styles/UserPanel.css';

interface UserPanelProps {
  isMicMuted: boolean;
  isDeafened: boolean;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  displayName: string;
  avatarUrl: string | null;
  onOpenProfile: () => void;
}

export default function UserPanel({
  isMicMuted,
  isDeafened,
  onToggleMic,
  onToggleDeafen,
  displayName,
  avatarUrl,
  onOpenProfile
}: UserPanelProps) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<'mic' | 'speaker' | null>(null);

  return (
    <div className="user-panel">
      <button className="user-panel__identity" onClick={onOpenProfile} title="Seu perfil">
        <div className="user-panel__avatar">
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
            <img src={isMicMuted ? micOffIcon : micIcon} alt="" />
          </button>
          <button
            className="user-panel__device-chevron-button"
            title="Escolher microfone"
            onClick={() => setOpenMenu((prev) => (prev === 'mic' ? null : 'mic'))}
          >
            <img src={chevronDownIcon} alt="" className="user-panel__device-chevron" />
          </button>
          {openMenu === 'mic' && (
            <DeviceMenu kind="audioinput" onSelect={() => {}} onClose={() => setOpenMenu(null)} />
          )}
        </div>

        <div className="user-panel__device-group">
          <button
            className={
              'user-panel__device-button' + (isDeafened ? ' user-panel__device-button--active' : '')
            }
            title={isDeafened ? 'Reativar áudio' : 'Silenciar tudo'}
            onClick={onToggleDeafen}
          >
            <img src={isDeafened ? headphonesOffIcon : headphonesIcon} alt="" />
          </button>
          <button
            className="user-panel__device-chevron-button"
            title="Escolher saída de áudio"
            onClick={() => setOpenMenu((prev) => (prev === 'speaker' ? null : 'speaker'))}
          >
            <img src={chevronDownIcon} alt="" className="user-panel__device-chevron" />
          </button>
          {openMenu === 'speaker' && (
            <DeviceMenu
              kind="audiooutput"
              onSelect={() => {}}
              onClose={() => setOpenMenu(null)}
              align="right"
            />
          )}
        </div>

        <button
          className="user-panel__icon-button"
          title="Configurações"
          onClick={() => setIsSettingsOpen(true)}
        >
          <img src={settingsIcon} alt="" />
        </button>
      </div>

      {isSettingsOpen && <SettingsModal onClose={() => setIsSettingsOpen(false)} />}
    </div>
  );
}
