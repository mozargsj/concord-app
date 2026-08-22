import { useEffect, useState } from 'react';
import type { ScreenSource } from '../types/window';
import '../styles/ScreenSharePicker.css';

interface ScreenSharePickerProps {
  onSelect: (source: ScreenSource, includeAudio: boolean) => void;
  onClose: () => void;
}

export default function ScreenSharePicker({ onSelect, onClose }: ScreenSharePickerProps) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [includeAudio, setIncludeAudio] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.concord.media.getScreenSources().then((result) => {
      if (!cancelled) setSources(result);
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
          <label className="screen-picker__audio-toggle">
            <input
              type="checkbox"
              checked={includeAudio}
              onChange={(event) => setIncludeAudio(event.target.checked)}
            />
            Incluir áudio do sistema
          </label>

          <button
            className="screen-picker__confirm"
            disabled={!selectedSource}
            onClick={() => selectedSource && onSelect(selectedSource, includeAudio)}
          >
            Compartilhar
          </button>
        </footer>
      </div>
    </div>
  );
}
