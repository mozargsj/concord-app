import { useState } from 'react';
import Button from './Button';
import EmojiPicker from './EmojiPicker';
import { promoteTempSound, type TempSound } from '../lib/soundTempCache';
import '../styles/ConfirmAddSoundModal.css';

const DEFAULT_VOLUME_PERCENT = 80;

interface ConfirmAddSoundModalProps {
  temp: TempSound;
  onClose: () => void;
  onAdded: () => void;
}

/** The confirmation step after previewing a peer's downloaded sound — decisions.md: baixar ≠
 * adicionar à lista própria, essa é a etapa que efetivamente adota o som (com um id novo, próprio
 * do usuário que está adicionando) depois de já ter ouvido a prévia. */
export default function ConfirmAddSoundModal({ temp, onClose, onAdded }: ConfirmAddSoundModalProps) {
  const [name, setName] = useState(temp.name);
  const [emoji, setEmoji] = useState(temp.emoji);
  const [volumePercent, setVolumePercent] = useState(DEFAULT_VOLUME_PERCENT);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Dá um nome pro áudio.');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await promoteTempSound(temp, { name: trimmedName, emoji, volume: volumePercent / 100 });
      onAdded();
      onClose();
    } catch {
      setError('Não foi possível adicionar esse áudio.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="confirm-add-sound-modal__backdrop" onClick={onClose}>
      <div className="confirm-add-sound-modal" onClick={(event) => event.stopPropagation()}>
        <header className="confirm-add-sound-modal__header">
          <h2>Adicionar aos meus áudios</h2>
          <button className="confirm-add-sound-modal__close" onClick={onClose} title="Fechar">
            ×
          </button>
        </header>

        <p className="confirm-add-sound-modal__source">
          Baixado de <strong>{temp.ownerName}</strong>
        </p>

        <audio src={temp.url} controls className="confirm-add-sound-modal__audio" />

        <div className="confirm-add-sound-modal__row">
          <div className="confirm-add-sound-modal__field confirm-add-sound-modal__field--grow">
            <label className="confirm-add-sound-modal__label">
              Nome do som <span className="confirm-add-sound-modal__required">*</span>
            </label>
            <input
              className="confirm-add-sound-modal__input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="confirm-add-sound-modal__field">
            <label className="confirm-add-sound-modal__label">Emoji</label>
            <EmojiPicker value={emoji} onChange={setEmoji} />
          </div>
        </div>

        <div className="confirm-add-sound-modal__section">
          <label className="confirm-add-sound-modal__label">Volume do som</label>
          <input
            type="range"
            min={0}
            max={100}
            value={volumePercent}
            onChange={(event) => setVolumePercent(Number(event.target.value))}
            className="confirm-add-sound-modal__slider"
          />
        </div>

        {error && <p className="confirm-add-sound-modal__error">{error}</p>}

        <div className="confirm-add-sound-modal__footer">
          <Button variant="ghost" onClick={onClose}>
            Deixa pra lá
          </Button>
          <Button onClick={handleConfirm} disabled={isSaving}>
            {isSaving ? 'Adicionando…' : 'Adicionar'}
          </Button>
        </div>
      </div>
    </div>
  );
}
