import { Pause, Play } from 'lucide-react';
import type { OwnSound } from '../lib/soundCache';
import '../styles/SoundboardPopover.css';

const ESTIMATED_WIDTH = 260;
const ESTIMATED_HEIGHT = 320;

interface PlayModeProps {
  mode: 'play';
  sounds: OwnSound[];
  /** Which sound (if any) is currently playing — drives the play/pause icon per row. */
  playingId: string | null;
  /** Same sound as playingId stops it; any other sound stops that one and starts this one. */
  onToggleSound: (sound: OwnSound) => void;
}

interface ConfigModeProps {
  mode: 'config';
  generalVolumePercent: number;
  onGeneralVolumeChange: (value: number) => void;
  onOpenManager: () => void;
}

type SoundboardPopoverProps = (PlayModeProps | ConfigModeProps) & {
  x: number;
  y: number;
  onClose: () => void;
};

/** Left-click ("play") and right-click ("config") popovers for the megafone button — same
 * clamped-to-cursor positioning as ContextMenu, but with richer content than a plain item list. */
export default function SoundboardPopover(props: SoundboardPopoverProps) {
  const { x, y, onClose } = props;
  const left = Math.min(x, window.innerWidth - ESTIMATED_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - ESTIMATED_HEIGHT - 8);

  return (
    <>
      <div
        className="soundboard-popover__backdrop"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div className="soundboard-popover" style={{ left, top }}>
        {props.mode === 'play' ? (
          <>
            <div className="soundboard-popover__title">Áudios</div>
            {props.sounds.length === 0 ? (
              <p className="soundboard-popover__hint">
                Você ainda não tem nenhum áudio — clique com o botão direito no megafone pra
                adicionar.
              </p>
            ) : (
              <div className="soundboard-popover__list">
                {props.sounds.map((sound) => {
                  const isPlaying = props.playingId === sound.id;
                  return (
                    <button
                      key={sound.id}
                      className="soundboard-popover__sound"
                      // Deliberately doesn't close the popover — the play/pause icon here is the
                      // whole point, closing on click would hide the only way to pause it back.
                      onClick={() => props.onToggleSound(sound)}
                    >
                      <span className="soundboard-popover__emoji">{sound.emoji || '🙂'}</span>
                      <span className="soundboard-popover__sound-name">{sound.name}</span>
                      {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="soundboard-popover__title">Volume dos efeitos sonoros</div>
            <input
              type="range"
              min={0}
              max={100}
              value={props.generalVolumePercent}
              onChange={(event) => props.onGeneralVolumeChange(Number(event.target.value))}
              className="soundboard-popover__slider"
            />
            <button
              className="soundboard-popover__manage-button"
              onClick={() => {
                onClose();
                props.onOpenManager();
              }}
            >
              Config. dos meus áudios
            </button>
          </>
        )}
      </div>
    </>
  );
}
