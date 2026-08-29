import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { ScreenSource } from '../types/window';
import {
  getIncludeAudioPreference,
  setIncludeAudioPreference,
  getScreenQualityMode,
  setScreenQualityMode,
  type ScreenQualityMode
} from '../lib/screenSharePreferences';
import NativeLoopbackHelpModal from './NativeLoopbackHelpModal';
import Toggle from './Toggle';
import Tooltip from './Tooltip';
import '../styles/ScreenSharePicker.css';

interface ScreenSharePickerProps {
  onSelect: (source: ScreenSource, includeAudio: boolean, qualityMode: ScreenQualityMode) => void;
  onClose: () => void;
}

export default function ScreenSharePicker({ onSelect, onClose }: ScreenSharePickerProps) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Starts from whatever was chosen last time (getIncludeAudioPreference), not always unchecked —
  // keeps the choice consistent across transmissions instead of resetting every time it's opened.
  const [includeAudio, setIncludeAudio] = useState(getIncludeAudioPreference);
  // Same "remember last choice" pattern — pedido do Mozar: qual lado da troca banda/qualidade
  // priorizar é decisão de quem compartilha, não algo fixo no app (webrtcMesh.ts's
  // setScreenQualityMode).
  const [qualityMode, setQualityMode] = useState<ScreenQualityMode>(getScreenQualityMode);
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
          <span className="screen-picker__quality-label">Se a banda apertar, priorizar:</span>
          <div className="screen-picker__quality-options">
            <button
              type="button"
              className={
                'screen-picker__quality-option' +
                (qualityMode === 'quality' ? ' screen-picker__quality-option--selected' : '')
              }
              onClick={() => {
                setQualityMode('quality');
                setScreenQualityMode('quality');
              }}
            >
              <span className="screen-picker__quality-option-title">Qualidade</span>
              <span className="screen-picker__quality-option-hint">
                Mantém nitidez, perde fps — ideal pra texto, documentos, apresentações
              </span>
            </button>
            <button
              type="button"
              className={
                'screen-picker__quality-option' +
                (qualityMode === 'smoothness' ? ' screen-picker__quality-option--selected' : '')
              }
              onClick={() => {
                setQualityMode('smoothness');
                setScreenQualityMode('smoothness');
              }}
            >
              <span className="screen-picker__quality-option-title">Fluidez</span>
              <span className="screen-picker__quality-option-hint">
                Mantém os fps, perde nitidez — ideal pra jogos e conteúdo dinâmico
              </span>
            </button>
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
              <button type="button" className="screen-picker__echo-hint" onClick={() => setIsHelpOpen(true)}>
                ⚠ Correção de eco indisponível neste PC — como ativar
              </button>
            )}
          </div>

          <button
            className="screen-picker__confirm"
            disabled={!selectedSource}
            onClick={() => selectedSource && onSelect(selectedSource, includeAudio, qualityMode)}
          >
            Compartilhar
          </button>
        </footer>
      </div>
      {isHelpOpen && <NativeLoopbackHelpModal onClose={() => setIsHelpOpen(false)} />}
    </div>
  );
}
