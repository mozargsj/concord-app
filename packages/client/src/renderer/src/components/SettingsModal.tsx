import { useEffect, useState } from 'react';
import {
  MIC_SENSITIVITY_DEFAULT,
  MIC_SENSITIVITY_MAX,
  MIC_SENSITIVITY_MIN,
  getMicSensitivity,
  setMicSensitivity
} from '../lib/micSensitivity';
import { getRnnoiseEnabled, setRnnoiseEnabled } from '../lib/noiseSuppressionSettings';
import '../styles/SettingsModal.css';

interface SettingsModalProps {
  onClose: () => void;
  /** Rebuilds the mic pipeline so a toggle takes effect immediately, mid-call — the RNNoise
   * AudioWorklet graph (or its absence) is only ever set up once, at mic-acquisition time. */
  onNoiseSuppressionChange: () => void;
}

export default function SettingsModal({ onClose, onNoiseSuppressionChange }: SettingsModalProps) {
  const [threshold, setThreshold] = useState(MIC_SENSITIVITY_DEFAULT);
  const [isRnnoiseEnabled, setIsRnnoiseEnabled] = useState(true);
  // Placeholder input level — same nature as the "está falando" mock in RoomView.tsx:
  // stand-in until the real gate reads audioLevel via getStats() (~20-50ms poll, per
  // the "Gate de ruído" decision). Only here to give the slider a visual reference.
  const [mockLevel, setMockLevel] = useState(0);

  useEffect(() => {
    setThreshold(getMicSensitivity());
    setIsRnnoiseEnabled(getRnnoiseEnabled());
  }, []);

  // Ties updates to the display's own refresh rate instead of a fixed interval — the
  // fastest a change can ever be visible, and any faster (e.g. 1ms) would just coalesce
  // into the same paint frame while burning CPU. Was 250ms, which read as laggy.
  useEffect(() => {
    let frameId: number;
    function tick() {
      setMockLevel(Math.round(30 + Math.random() * 55));
      frameId = requestAnimationFrame(tick);
    }
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  function handleThresholdChange(value: number) {
    setThreshold(value);
    setMicSensitivity(value);
  }

  function handleToggleRnnoise() {
    const next = !isRnnoiseEnabled;
    setIsRnnoiseEnabled(next);
    setRnnoiseEnabled(next);
    onNoiseSuppressionChange();
  }

  const isGateOpen = mockLevel >= threshold;

  return (
    <div className="settings-modal__backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
        <header className="settings-modal__header">
          <h2>Configurações de voz</h2>
          <button className="settings-modal__close" onClick={onClose} title="Fechar">
            ×
          </button>
        </header>

        <div className="settings-modal__section">
          <label className="settings-modal__toggle-row" htmlFor="rnnoise-toggle">
            <span>
              <span className="settings-modal__label">Redução de ruído (RNNoise)</span>
              <p className="settings-modal__hint">
                Remove ruído de fundo (teclado, clique do mouse, ventilador) com um modelo
                dedicado — mais eficaz que a supressão padrão do navegador.
              </p>
            </span>
            <input
              id="rnnoise-toggle"
              type="checkbox"
              checked={isRnnoiseEnabled}
              onChange={handleToggleRnnoise}
              className="settings-modal__checkbox"
            />
          </label>
        </div>

        <div className="settings-modal__section">
          <label className="settings-modal__label" htmlFor="mic-sensitivity">
            Sensibilidade do microfone
          </label>
          <p className="settings-modal__hint">
            Define o limiar do corte automático de ruído — abaixo da linha, o microfone é
            silenciado.
          </p>

          <div className={'settings-modal__meter' + (isGateOpen ? ' settings-modal__meter--open' : '')}>
            <div className="settings-modal__meter-fill" style={{ width: `${mockLevel}%` }} />
            <div className="settings-modal__meter-threshold" style={{ left: `${threshold}%` }} />
          </div>

          <input
            id="mic-sensitivity"
            type="range"
            min={MIC_SENSITIVITY_MIN}
            max={MIC_SENSITIVITY_MAX}
            value={threshold}
            onChange={(event) => handleThresholdChange(Number(event.target.value))}
            className="settings-modal__slider"
          />
        </div>
      </div>
    </div>
  );
}
