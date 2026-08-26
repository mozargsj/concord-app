import { useEffect, useState } from 'react';
import type { ScreenSource } from '../types/window';
import { getIncludeAudioPreference, setIncludeAudioPreference } from '../lib/screenSharePreferences';
import NativeLoopbackHelpModal from './NativeLoopbackHelpModal';
import '../styles/ScreenSharePicker.css';

interface ScreenSharePickerProps {
  onSelect: (source: ScreenSource, includeAudio: boolean) => void;
  onClose: () => void;
}

export default function ScreenSharePicker({ onSelect, onClose }: ScreenSharePickerProps) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Starts from whatever was chosen last time (getIncludeAudioPreference), not always unchecked —
  // keeps the choice consistent across transmissions instead of resetting every time it's opened.
  const [includeAudio, setIncludeAudio] = useState(getIncludeAudioPreference);
  // null while the check is in flight — the hint only makes sense once we actually know either way.
  const [isEchoFixAvailable, setIsEchoFixAvailable] = useState<boolean | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.concord.media.getScreenSources().then((result) => {
      if (!cancelled) setSources(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.concord.processLoopback
      .isAvailable()
      .then((available) => {
        if (!cancelled) setIsEchoFixAvailable(available);
      })
      .catch(() => {
        if (!cancelled) setIsEchoFixAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const screens = (sources ?? []).filter((source) => source.id.startsWith('screen:'));
  const windows = (sources ?? []).filter((source) => source.id.startsWith('window:'));
  const selectedSource = sources?.find((source) => source.id === selectedId) ?? null;

  function renderGroup(title: string, items: ScreenSource[]) {
    if (items.length === 0) return null;
    return (
      <div className="screen-picker__section">
        <h3 className="screen-picker__section-title">{title}</h3>
        <div className="screen-picker__grid">
          {items.map((source) => (
            <button
              key={source.id}
              className={
                'screen-picker__item' + (source.id === selectedId ? ' screen-picker__item--selected' : '')
              }
              onClick={() => setSelectedId(source.id)}
            >
              <img src={source.thumbnailDataUrl} alt="" className="screen-picker__thumbnail" />
              <span className="screen-picker__name">{source.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="screen-picker__backdrop" onClick={onClose}>
      <div className="screen-picker" onClick={(event) => event.stopPropagation()}>
        <header className="screen-picker__header">
          <h2>Escolha o que transmitir</h2>
          <button className="screen-picker__close" onClick={onClose} title="Fechar">
            ×
          </button>
        </header>

        {sources === null && <p className="screen-picker__hint">Carregando telas e janelas…</p>}

        <div className="screen-picker__body">
          {renderGroup(screens.length > 1 ? 'Telas' : 'Tela inteira', screens)}
          {renderGroup('Aplicativos', windows)}
        </div>

        <footer className="screen-picker__footer">
          <div className="screen-picker__audio-column">
            <label className="screen-picker__audio-toggle">
              <input
                type="checkbox"
                checked={includeAudio}
                onChange={(event) => {
                  setIncludeAudio(event.target.checked);
                  setIncludeAudioPreference(event.target.checked);
                }}
              />
              Incluir áudio do sistema
            </label>
            {includeAudio && isEchoFixAvailable === false && (
              <button type="button" className="screen-picker__echo-hint" onClick={() => setIsHelpOpen(true)}>
                ⚠ Correção de eco indisponível neste PC — como ativar
              </button>
            )}
          </div>

          <button
            className="screen-picker__confirm"
            disabled={!selectedSource}
            onClick={() => selectedSource && onSelect(selectedSource, includeAudio)}
          >
            Compartilhar
          </button>
        </footer>
      </div>
      {isHelpOpen && <NativeLoopbackHelpModal onClose={() => setIsHelpOpen(false)} />}
    </div>
  );
}
