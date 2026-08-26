import { Download, Loader2, Pause, Play, Plus } from 'lucide-react';
import { getAvatarColor } from '../lib/avatarColor';
import type { OwnSound } from '../lib/soundCache';
import type { SoundListEntry } from '../lib/webrtcMesh';
import '../styles/SoundboardPopover.css';

const ESTIMATED_WIDTH_CONFIG = 260;
const ESTIMATED_WIDTH_PLAY = 300;
const ESTIMATED_HEIGHT = 380;

interface SoundboardParticipant {
  peerId: string;
  displayName: string;
  avatarUrl: string | null;
}

interface PlayModeProps {
  mode: 'play';
  ownSounds: OwnSound[];
  /** Which own sound (if any) is currently playing — drives the play/pause icon per row. */
  playingOwnSoundId: string | null;
  /** Same sound as playingOwnSoundId stops it; any other sound stops that one and starts this one. */
  onToggleOwnSound: (sound: OwnSound) => void;

  selfDisplayName: string;
  selfAvatarUrl: string | null;
  /** Room participants (self excluded from this list — it's the first avatar in the strip
   * instead, see render below). Clicking one asks for their catalog live (decisions.md:
   * descoberta só ao vivo, sempre pelo canal de dados). */
  participants: SoundboardParticipant[];
  /** null = viewing my own sounds (the default / first avatar). */
  selectedPeer: SoundboardParticipant | null;
  onSelectPeer: (peer: SoundboardParticipant | null) => void;
  /** null while the selected peer's catalog hasn't arrived yet (still "ao vivo", no cache to fall back on). */
  peerSounds: SoundListEntry[] | null;
  /** soundId -> already downloaded into the temporary preview cache. */
  downloadedSoundIds: Set<string>;
  /** soundId -> download currently in flight (requested but not yet in downloadedSoundIds). */
  downloadingSoundIds: Set<string>;
  onDownloadSound: (entry: SoundListEntry) => void;
  playingTempSoundId: string | null;
  onToggleTempPreview: (soundId: string) => void;
  onConfirmAdd: (soundId: string) => void;
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
 * clamped-to-cursor positioning as ContextMenu, but with richer content than a plain item list.
 * "play" mode is a vertical avatar rail (self first, then the room roster) — same visual
 * language as the app's own ServerRail (a narrower, darker-background column of circular icons)
 * — next to whichever person's sound list is currently selected; never a persisted catalog,
 * only ever fetched live. */
export default function SoundboardPopover(props: SoundboardPopoverProps) {
  const { x, y, onClose } = props;
  const estimatedWidth = props.mode === 'play' ? ESTIMATED_WIDTH_PLAY : ESTIMATED_WIDTH_CONFIG;
  const left = Math.min(x, window.innerWidth - estimatedWidth - 8);
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
      <div
        className={'soundboard-popover' + (props.mode === 'play' ? ' soundboard-popover--play' : ' soundboard-popover--config')}
        style={{ left, top, width: estimatedWidth }}
      >
        {props.mode === 'play' ? (
          <PlayView {...props} />
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

function Avatar({ name, url }: { name: string; url: string | null }) {
  return (
    <span
      className="soundboard-popover__avatar-image"
      style={url ? undefined : { background: getAvatarColor(name) }}
    >
      {url ? <img src={url} alt="" /> : name.charAt(0).toUpperCase()}
    </span>
  );
}

function PlayView(props: PlayModeProps) {
  const isViewingSelf = props.selectedPeer === null;

  return (
    <div className="soundboard-popover__play-layout">
      <div className="soundboard-popover__rail">
        <button
          className={'soundboard-popover__avatar-item' + (isViewingSelf ? ' soundboard-popover__avatar-item--active' : '')}
          onClick={() => props.onSelectPeer(null)}
          title={props.selfDisplayName}
        >
          <Avatar name={props.selfDisplayName} url={props.selfAvatarUrl} />
        </button>
        {props.participants.map((participant) => (
          <button
            key={participant.peerId}
            className={
              'soundboard-popover__avatar-item' +
              (props.selectedPeer?.peerId === participant.peerId ? ' soundboard-popover__avatar-item--active' : '')
            }
            onClick={() => props.onSelectPeer(participant)}
            title={participant.displayName}
          >
            <Avatar name={participant.displayName} url={participant.avatarUrl} />
          </button>
        ))}
      </div>

      <div className="soundboard-popover__content">
        <div className="soundboard-popover__title">{isViewingSelf ? 'Meus áudios' : props.selectedPeer!.displayName}</div>
        {isViewingSelf ? <OwnSoundsList {...props} /> : <PeerSoundsList {...props} />}
      </div>
    </div>
  );
}

function OwnSoundsList(props: PlayModeProps) {
  if (props.ownSounds.length === 0) {
    return (
      <p className="soundboard-popover__hint">
        Você ainda não tem nenhum áudio — clique com o botão direito no megafone pra adicionar.
      </p>
    );
  }
  return (
    <div className="soundboard-popover__list">
      {props.ownSounds.map((sound) => {
        const isPlaying = props.playingOwnSoundId === sound.id;
        return (
          <button
            key={sound.id}
            className="soundboard-popover__sound"
            // Deliberately doesn't close the popover — the play/pause icon here is the whole
            // point, closing on click would hide the only way to pause it back.
            onClick={() => props.onToggleOwnSound(sound)}
          >
            <span className="soundboard-popover__emoji">{sound.emoji || '🙂'}</span>
            <span className="soundboard-popover__sound-name">{sound.name}</span>
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
        );
      })}
    </div>
  );
}

function PeerSoundsList(props: PlayModeProps) {
  if (props.peerSounds === null) {
    return <p className="soundboard-popover__hint">Carregando…</p>;
  }
  if (props.peerSounds.length === 0) {
    return <p className="soundboard-popover__hint">Essa pessoa não tem nenhum áudio.</p>;
  }
  return (
    <div className="soundboard-popover__list">
      {props.peerSounds.map((entry) => {
        const isDownloaded = props.downloadedSoundIds.has(entry.soundId);
        const isDownloading = props.downloadingSoundIds.has(entry.soundId);
        const isPlaying = props.playingTempSoundId === entry.soundId;
        return (
          <div key={entry.soundId} className="soundboard-popover__sound soundboard-popover__sound--row">
            <span className="soundboard-popover__emoji">{entry.emoji || '🙂'}</span>
            <span className="soundboard-popover__sound-name">{entry.name}</span>
            {isDownloaded ? (
              <>
                <button
                  className="soundboard-popover__icon-button"
                  onClick={() => props.onToggleTempPreview(entry.soundId)}
                  title={isPlaying ? 'Pausar' : 'Ouvir prévia'}
                >
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  className="soundboard-popover__icon-button"
                  onClick={() => props.onConfirmAdd(entry.soundId)}
                  title="Adicionar aos meus áudios"
                >
                  <Plus size={14} />
                </button>
              </>
            ) : isDownloading ? (
              <button className="soundboard-popover__icon-button" disabled title="Baixando…">
                <Loader2 size={14} className="soundboard-popover__spin" />
              </button>
            ) : (
              <button
                className="soundboard-popover__icon-button"
                onClick={() => props.onDownloadSound(entry)}
                title="Baixar prévia"
              >
                <Download size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
