import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { ScreenSource } from '../types/window';
import {
  getIncludeAudioPreference,
  setIncludeAudioPreference,
  getScreenFrameRate,
  setScreenFrameRate,
  type ScreenFrameRate
} from '../lib/screenSharePreferences';
import SmartAppControlHint from './SmartAppControlHint';
import Toggle from './Toggle';
import Tooltip from './Tooltip';
import '../styles/ScreenSharePicker.css';

interface ScreenSharePickerProps {
  onSelect: (source: ScreenSource, includeAudio: boolean, frameRate: ScreenFrameRate) => void;
  onClose: () => void;
}

export default function ScreenSharePicker({ onSelect, onClose }: ScreenSharePickerProps) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Starts from whatever was chosen last time (getIncludeAudioPreference), not always unchecked —
  // keeps the choice consistent across transmissions instead of resetting every time it's opened.
  const [includeAudio, setIncludeAudio] = useState(getIncludeAudioPreference);
  // Same "remember last choice" pattern — always 1080p, only the frame rate is chosen here
  // (screenSharePreferences.ts).
  const [frameRate, setFrameRate] = useState<ScreenFrameRate>(getScreenFrameRate);
  // null while the check is in flight — the hint only makes sense once we actually know either way.
  const [isEchoFixAvailable, setIsEchoFixAvailable] = useState<boolean | null>(null);

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
          <Tooltip label="Fechar">
            <button className="screen-picker__close" onClick={onClose}>
              <X size={18} />
            </button>
          </Tooltip>
        </header>

        {sources === null && <p className="screen-picker__hint">Carregando telas e janelas…</p>}

        <div className="screen-picker__body">
          {renderGroup(screens.length > 1 ? 'Telas' : 'Tela inteira', screens)}
          {renderGroup('Aplicativos', windows)}
        </div>

        <div className="screen-picker__quality-section">
          <span className="screen-picker__quality-label">Transmitir em:</span>
          <div className="screen-picker__quality-options">
            {(
              [
                { value: 60, title: '1080p 60 fps', hint: 'Mais fluido — pesa mais no PC de quem transmite' },
                { value: 30, title: '1080p 30 fps', hint: 'Metade do custo — use se o jogo perder fps' }
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                className={
                  'screen-picker__quality-option' +
                  (frameRate === option.value ? ' screen-picker__quality-option--selected' : '')
                }
                onClick={() => {
                  setFrameRate(option.value);
                  setScreenFrameRate(option.value);
                }}
              >
                <span className="screen-picker__quality-option-title">{option.title}</span>
                <span className="screen-picker__quality-option-hint">{option.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <footer className="screen-picker__footer">
          <div className="screen-picker__audio-column">
            <label className="screen-picker__audio-toggle">
              <Toggle
                checked={includeAudio}
                onChange={(checked) => {
                  setIncludeAudio(checked);
                  setIncludeAudioPreference(checked);
                }}
              />
              Incluir áudio do sistema
            </label>
            {includeAudio && isEchoFixAvailable === false && (
              <SmartAppControlHint text="Correção de eco indisponível neste PC" />
            )}
          </div>

          <button
            className="screen-picker__confirm"
            disabled={!selectedSource}
            onClick={() => selectedSource && onSelect(selectedSource, includeAudio, frameRate)}
          >
            Compartilhar
          </button>
        </footer>
      </div>
    </div>
  );
}
