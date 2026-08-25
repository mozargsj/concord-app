import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import Button from './Button';
import EmojiPicker from './EmojiPicker';
import WaveformTrimmer from './WaveformTrimmer';
import { decodeAudioFile, encodeWav, getSharedAudioContext, renderTrimmedClip, WAV_MIME_TYPE } from '../lib/audioClip';
import { generateSoundId, saveOwnSound, updateOwnSoundMeta, type OwnSound } from '../lib/soundCache';
import '../styles/AddSoundModal.css';

const MAX_DURATION_SEC = 15;
const DEFAULT_VOLUME_PERCENT = 80;

interface AddSoundModalProps {
  /** When set, edits this sound's metadata instead of adding a new one — the waveform/trim step
   * is skipped (only the already-trimmed clip is stored, there's no original to re-cut) unless
   * the user explicitly chooses "Trocar áudio". */
  editingSound?: OwnSound | null;
  onClose: () => void;
  onSaved: (sound: OwnSound) => void;
}

export default function AddSoundModal({ editingSound, onClose, onSaved }: AddSoundModalProps) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [name, setName] = useState(editingSound?.name ?? '');
  const [emoji, setEmoji] = useState(editingSound?.emoji ?? '');
  const [volumePercent, setVolumePercent] = useState(
    editingSound ? Math.round(editingSound.volume * 100) : DEFAULT_VOLUME_PERCENT
  );
  const [isReplacingAudio, setIsReplacingAudio] = useState(!editingSound);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  // Absolute position (seconds into the full buffer, not just the selection) — null hides the
  // waveform's playhead line entirely, e.g. before anything has ever played.
  const [playheadSec, setPlayheadSec] = useState<number | null>(null);

  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const previewRafRef = useRef<number | null>(null);
  // ctx.currentTime when the current playback segment started, and how far into the selection
  // it started from — together they let the rAF loop compute "now" without polling the source.
  const previewSegmentStartRef = useRef({ ctxTime: 0, offsetIntoSelection: 0 });

  const needsNewAudio = isReplacingAudio;

  function stopPreview() {
    previewSourceRef.current?.stop();
    previewSourceRef.current = null;
    if (previewRafRef.current !== null) cancelAnimationFrame(previewRafRef.current);
    previewRafRef.current = null;
    setIsPreviewPlaying(false);
  }

  useEffect(() => {
    return () => {
      previewSourceRef.current?.stop();
      if (previewRafRef.current !== null) cancelAnimationFrame(previewRafRef.current);
    };
  }, []);

  async function handlePickFile() {
    setError(null);
    stopPreview();
    setPlayheadSec(null);
    const picked = await window.concord.media.pickAudio();
    if (!picked) return;
    try {
      const decoded = await decodeAudioFile(picked.data);
      setBuffer(decoded);
      setRange({ start: 0, end: Math.min(decoded.duration, MAX_DURATION_SEC) });
    } catch {
      setError('Não foi possível ler esse arquivo de áudio.');
    }
  }

  async function startPreviewFrom(offsetIntoSelection: number) {
    if (!buffer) return;
    stopPreview();
    const trimmed = await renderTrimmedClip(buffer, range.start, range.end);
    const ctx = getSharedAudioContext();
    void ctx.resume().catch(() => {});

    const clampedOffset = Math.max(0, Math.min(offsetIntoSelection, trimmed.duration));
    const source = ctx.createBufferSource();
    source.buffer = trimmed;
    source.connect(ctx.destination);
    source.start(0, clampedOffset);

    previewSourceRef.current = source;
    previewSegmentStartRef.current = { ctxTime: ctx.currentTime, offsetIntoSelection: clampedOffset };
    setIsPreviewPlaying(true);
    setPlayheadSec(range.start + clampedOffset);

    source.onended = () => {
      if (previewSourceRef.current === source) {
        previewSourceRef.current = null;
        setIsPreviewPlaying(false);
      }
    };

    const tick = () => {
      const { ctxTime, offsetIntoSelection: segmentOffset } = previewSegmentStartRef.current;
      const elapsed = ctx.currentTime - ctxTime;
      const positionInSelection = segmentOffset + elapsed;
      if (positionInSelection >= range.end - range.start) {
        setPlayheadSec(range.end);
        return; // clip finishes on its own — onended above handles the isPreviewPlaying flip
      }
      setPlayheadSec(range.start + positionInSelection);
      previewRafRef.current = requestAnimationFrame(tick);
    };
    previewRafRef.current = requestAnimationFrame(tick);
  }

  function handlePreviewToggle() {
    if (isPreviewPlaying) {
      stopPreview();
      return;
    }
    // Resume from wherever the playhead was left (e.g. dragged back), or from the start of the
    // selection the very first time.
    const resumeFrom = playheadSec !== null ? playheadSec - range.start : 0;
    void startPreviewFrom(resumeFrom);
  }

  function handleSeekPlayhead(sec: number) {
    setPlayheadSec(sec);
    if (isPreviewPlaying) void startPreviewFrom(sec - range.start);
  }

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Dá um nome pro áudio.');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      if (editingSound && !needsNewAudio) {
        const volume = volumePercent / 100;
        await updateOwnSoundMeta(editingSound.id, { name: trimmedName, emoji, volume });
        onSaved({ ...editingSound, name: trimmedName, emoji, volume });
        onClose();
        return;
      }

      if (!buffer) {
        setError('Escolhe um arquivo de áudio primeiro.');
        return;
      }

      const trimmed = await renderTrimmedClip(buffer, range.start, range.end);
      const wavData = encodeWav(trimmed);
      const saved = await saveOwnSound(
        {
          id: editingSound?.id ?? generateSoundId(),
          name: trimmedName,
          emoji,
          volume: volumePercent / 100,
          durationMs: Math.round((range.end - range.start) * 1000),
          mimeType: WAV_MIME_TYPE
        },
        wavData
      );
      onSaved(saved);
      onClose();
    } catch {
      setError('Não foi possível salvar o áudio.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="add-sound-modal__backdrop" onClick={onClose}>
      <div className="add-sound-modal" onClick={(event) => event.stopPropagation()}>
        <header className="add-sound-modal__header">
          <h2>{editingSound ? 'Editar som' : 'Enviar um som'}</h2>
          <button className="add-sound-modal__close" onClick={onClose} title="Fechar">
            ×
          </button>
        </header>

        <div className="add-sound-modal__section">
          <label className="add-sound-modal__label">Prévia</label>
          {needsNewAudio ? (
            buffer ? (
              <>
                <WaveformTrimmer
                  buffer={buffer}
                  maxDurationSec={MAX_DURATION_SEC}
                  onRangeChange={(start, end) => {
                    setRange({ start, end });
                    // Dragging the trim handles can leave a previously-set playhead outside the
                    // new selection — keep it inside rather than showing a line off in the masked-out area.
                    setPlayheadSec((prev) => (prev === null ? null : Math.max(start, Math.min(end, prev))));
                  }}
                  playheadSec={playheadSec}
                  onSeekPlayhead={handleSeekPlayhead}
                />
                <div className="add-sound-modal__preview-row">
                  <button
                    className="add-sound-modal__preview-button"
                    onClick={handlePreviewToggle}
                    title={isPreviewPlaying ? 'Pausar' : 'Ouvir seleção'}
                  >
                    {isPreviewPlaying ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                  <button className="add-sound-modal__link" onClick={handlePickFile}>
                    Trocar arquivo
                  </button>
                </div>
              </>
            ) : (
              <Button variant="ghost" onClick={handlePickFile}>
                Escolher arquivo
              </Button>
            )
          ) : (
            editingSound && (
              <div className="add-sound-modal__existing-preview">
                <audio src={editingSound.url} controls className="add-sound-modal__audio" />
                <button className="add-sound-modal__link" onClick={() => setIsReplacingAudio(true)}>
                  Trocar áudio
                </button>
              </div>
            )
          )}
        </div>

        <div className="add-sound-modal__row">
          <div className="add-sound-modal__field add-sound-modal__field--grow">
            <label className="add-sound-modal__label">
              Nome do som <span className="add-sound-modal__required">*</span>
            </label>
            <input
              className="add-sound-modal__input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Macaquito"
            />
          </div>
          <div className="add-sound-modal__field">
            <label className="add-sound-modal__label">Emoji relacionado</label>
            <EmojiPicker value={emoji} onChange={setEmoji} />
          </div>
        </div>

        <div className="add-sound-modal__section">
          <label className="add-sound-modal__label">Volume do som</label>
          <input
            type="range"
            min={0}
            max={100}
            value={volumePercent}
            onChange={(event) => setVolumePercent(Number(event.target.value))}
            className="add-sound-modal__slider"
          />
        </div>

        {error && <p className="add-sound-modal__error">{error}</p>}

        <div className="add-sound-modal__footer">
          <Button variant="ghost" onClick={onClose}>
            Deixa pra lá
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Enviando…' : 'Enviar'}
          </Button>
        </div>
      </div>
    </div>
  );
}
