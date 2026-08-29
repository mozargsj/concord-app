import { useEffect, useRef, useState } from 'react';
import { Pause, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import Button from './Button';
import ConfirmModal from './ConfirmModal';
import AddSoundModal from './AddSoundModal';
import Tooltip from './Tooltip';
import { deleteOwnSound, listOwnSounds, type OwnSound } from '../lib/soundCache';
import '../styles/SoundboardManagerModal.css';

interface SoundboardManagerModalProps {
  onClose: () => void;
  /** Own sounds changed (added/edited/deleted) — lets the quick-play popover elsewhere refresh
   * without both components needing to share state. */
  onSoundsChanged?: () => void;
}

/** The soundboard's own-audios management screen (decisions.md — right-click on the megafone):
 * add, edit (name/emoji/volume), delete, and a local-only preview of each sound. */
export default function SoundboardManagerModal({ onClose, onSoundsChanged }: SoundboardManagerModalProps) {
  const [sounds, setSounds] = useState<OwnSound[] | null>(null);
  const [addModalState, setAddModalState] = useState<'closed' | 'add' | OwnSound>('closed');
  const [pendingDelete, setPendingDelete] = useState<OwnSound | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const playingAudioRef = useRef<HTMLAudioElement | null>(null);

  async function refresh() {
    setSounds(await listOwnSounds());
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Stops local preview playback when the modal itself closes — otherwise a sound could keep
  // playing in the background with no visible toggle left to pause it.
  useEffect(() => {
    return () => {
      playingAudioRef.current?.pause();
    };
  }, []);

  function handleTogglePreview(sound: OwnSound) {
    if (playingId === sound.id) {
      playingAudioRef.current?.pause();
      playingAudioRef.current = null;
      setPlayingId(null);
      return;
    }
    // Switching to a different sound (or starting fresh) — stop whatever was playing first,
    // otherwise clicking play on two rows in a row overlaps them instead of replacing.
    playingAudioRef.current?.pause();
    const audio = new Audio(sound.url);
    audio.volume = sound.volume;
    audio.onended = () => {
      setPlayingId((current) => (current === sound.id ? null : current));
      playingAudioRef.current = null;
    };
    playingAudioRef.current = audio;
    setPlayingId(sound.id);
    void audio.play();
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    if (playingId === pendingDelete.id) {
      playingAudioRef.current?.pause();
      playingAudioRef.current = null;
      setPlayingId(null);
    }
    await deleteOwnSound(pendingDelete.id);
    setPendingDelete(null);
    await refresh();
    onSoundsChanged?.();
  }

  function handleSaved() {
    void refresh();
    onSoundsChanged?.();
  }

  return (
    <div className="soundboard-manager__backdrop" onClick={onClose}>
      <div className="soundboard-manager" onClick={(event) => event.stopPropagation()}>
        <header className="soundboard-manager__header">
          <h2>Meus áudios</h2>
          <Tooltip label="Fechar">
            <button className="soundboard-manager__close" onClick={onClose}>
              <X size={18} />
            </button>
          </Tooltip>
        </header>

        <Button onClick={() => setAddModalState('add')} className="soundboard-manager__add-button">
          <Plus size={16} /> Enviar som
        </Button>

        <div className="soundboard-manager__list">
          {sounds === null && <p className="soundboard-manager__hint">Carregando…</p>}
          {sounds !== null && sounds.length === 0 && (
            <p className="soundboard-manager__hint">Você ainda não tem nenhum áudio.</p>
          )}
          {sounds?.map((sound) => (
            <div key={sound.id} className="soundboard-manager__row">
              <button
                className="soundboard-manager__play"
                onClick={() => handleTogglePreview(sound)}
                title={playingId === sound.id ? 'Pausar' : 'Ouvir'}
              >
                {playingId === sound.id ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <span className="soundboard-manager__emoji">{sound.emoji || '🙂'}</span>
              <span className="soundboard-manager__name">{sound.name}</span>
              <span className="soundboard-manager__duration">{(sound.durationMs / 1000).toFixed(1)}s</span>
              <button className="soundboard-manager__icon-button" onClick={() => setAddModalState(sound)} title="Editar">
                <Pencil size={14} />
              </button>
              <button
                className="soundboard-manager__icon-button soundboard-manager__icon-button--danger"
                onClick={() => setPendingDelete(sound)}
                title="Excluir"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {addModalState !== 'closed' && (
        <AddSoundModal
          editingSound={addModalState === 'add' ? null : addModalState}
          onClose={() => setAddModalState('closed')}
          onSaved={handleSaved}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Excluir áudio"
          message={`Excluir o áudio "${pendingDelete.name}"? Essa ação não pode ser desfeita.`}
          confirmLabel="Excluir"
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}
