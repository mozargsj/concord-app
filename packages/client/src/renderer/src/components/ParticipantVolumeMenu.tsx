import { User, VolumeX } from 'lucide-react';
import Tooltip from './Tooltip';
import '../styles/ParticipantVolumeMenu.css';
import '../styles/ValueBubble.css';

const VOLUME_MAX = 200;
// [2026-08-30, pedido do Mozar] +50% sobre o tamanho original (14) dos ícones deste menu.
const ACTION_ICON_SIZE = 21;

interface ParticipantVolumeMenuProps {
  x: number;
  y: number;
  name: string;
  volume: number;
  isMuted: boolean;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  onViewProfile: () => void;
  onClose: () => void;
}

const ESTIMATED_WIDTH = 220;
const ESTIMATED_HEIGHT = 170;

/** Right-click on a participant tile (RoomView) — local-only volume/mute for this one listener,
 * same premise as devicePreferences.ts: never touches the mesh/signaling, never affects what
 * anyone else hears. Positioned/clamped like ContextMenu, but the content (slider) needs to stay
 * open while being dragged, unlike ContextMenu's click-one-item-and-close items. */
export default function ParticipantVolumeMenu({
  x,
  y,
  name,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  onViewProfile,
  onClose
}: ParticipantVolumeMenuProps) {
  const left = Math.min(x, window.innerWidth - ESTIMATED_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - ESTIMATED_HEIGHT - 8);

  return (
    <>
      <div
        className="participant-volume-menu__backdrop"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div className="participant-volume-menu" style={{ left, top }}>
        <p className="participant-volume-menu__name">{name}</p>
        <div className="participant-volume-menu__row">
          <div className="participant-volume-menu__slider-wrap">
            <div className="value-bubble" style={{ left: `${((isMuted ? 0 : volume) / VOLUME_MAX) * 100}%` }}>
              {isMuted ? 0 : volume}%
            </div>
            <input
              type="range"
              min={0}
              max={VOLUME_MAX}
              value={isMuted ? 0 : volume}
              onChange={(event) => onVolumeChange(Number(event.target.value))}
              className="participant-volume-menu__slider"
            />
          </div>
        </div>
        <div className="participant-volume-menu__actions">
          <Tooltip label={isMuted ? 'Desmutar pra mim' : 'Mutar pra mim'}>
            <button
              type="button"
              className={
                'participant-volume-menu__icon-action' +
                (isMuted ? ' participant-volume-menu__icon-action--active' : '')
              }
              onClick={onToggleMute}
            >
              <VolumeX size={ACTION_ICON_SIZE} />
            </button>
          </Tooltip>
          <Tooltip label="Ver perfil">
            <button type="button" className="participant-volume-menu__icon-action" onClick={onViewProfile}>
              <User size={ACTION_ICON_SIZE} />
            </button>
          </Tooltip>
        </div>
      </div>
    </>
  );
}
