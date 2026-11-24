import { useEffect, useState } from 'react';
import { VolumeX, X } from 'lucide-react';
import type { AudioSession, ScreenSource } from '../types/window';
import { listAudioSessions } from '../lib/processLoopbackAudio';
import {
  getIncludeAudioPreference,
  setIncludeAudioPreference,
  getScreenFrameRate,
  setScreenFrameRate,
  getExcludedAudioApps,
  setExcludedAudioApps,
  isDefaultExcludedAudioApp,
  type ExcludedAudioApp,
  type ScreenFrameRate
} from '../lib/screenSharePreferences';
import SmartAppControlHint from './SmartAppControlHint';
import Toggle from './Toggle';
import Tooltip from './Tooltip';
import '../styles/ScreenSharePicker.css';

interface ScreenSharePickerProps {
  /** Owner of the "don't transmit these apps' audio" list (screenSharePreferences.ts). */
  userId: string;
  onSelect: (source: ScreenSource, includeAudio: boolean, frameRate: ScreenFrameRate) => void;
  onClose: () => void;
}

// Same cadence as AudioSharePicker: WASAPI only lists an app while it's playing, so the list
// picks up whoever presses play after the picker opened.
const AUDIO_SESSIONS_REFRESH_MS = 1500;

const sameExe = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export default function ScreenSharePicker({ userId, onSelect, onClose }: ScreenSharePickerProps) {
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

  // [Pedido do Mozar, 2026-11-24] Apps kept out of the system audio. Only with the native addon:
  // without it the system audio is the whole desktop mix and nothing can be taken out of it.
  const [excludedApps, setExcludedApps] = useState<ExcludedAudioApp[]>(() => getExcludedAudioApps(userId));
  const [audioSessions, setAudioSessions] = useState<AudioSession[]>([]);
  const showAppExclusions = includeAudio && isEchoFixAvailable === true;

  useEffect(() => {
    if (!showAppExclusions) return;
    let cancelled = false;
    const refresh = () =>
      listAudioSessions()
        .then((result) => {
          if (!cancelled) setAudioSessions(result);
        })
        .catch(() => {});
    refresh();
    const interval = setInterval(refresh, AUDIO_SESSIONS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showAppExclusions]);

  // Apps the user excluded stay listed even when silent, so they can be put back; then whoever is
  // playing. Default exclusions (call apps) only show while playing: listing every call app the PC
  // may not even have would bury the real choices. Sorted by name so a chip doesn't jump around
  // when toggled or when the poll reorders sessions.
  const appChoices = excludedApps.filter((app) => !isDefaultExcludedAudioApp(app.exe));
  for (const session of audioSessions) {
    if (session.exe && !appChoices.some((app) => sameExe(app.exe, session.exe))) {
      appChoices.push({ exe: session.exe, name: session.name });
    }
  }
  appChoices.sort((a, b) => a.name.localeCompare(b.name));

  function toggleExcludedApp(app: ExcludedAudioApp) {
    const next = excludedApps.some((excluded) => sameExe(excluded.exe, app.exe))
      ? excludedApps.filter((excluded) => !sameExe(excluded.exe, app.exe))
      : [...excludedApps, app];
    setExcludedApps(next);
    setExcludedAudioApps(userId, next);
  }

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

        {showAppExclusions && (
          <div className="screen-picker__quality-section">
            <span className="screen-picker__quality-label">Não transmitir o áudio de:</span>
            {appChoices.length === 0 ? (
              <p className="screen-picker__hint">
                Nenhum aplicativo está tocando som agora. Dê play no app que você quer tirar da transmissão.
              </p>
            ) : (
              <div className="screen-picker__app-chips">
                {appChoices.map((app) => {
                  const excluded = excludedApps.some((item) => sameExe(item.exe, app.exe));
                  return (
                    <button
                      key={app.exe.toLowerCase()}
                      type="button"
                      aria-pressed={excluded}
                      className={'screen-picker__app-chip' + (excluded ? ' screen-picker__app-chip--excluded' : '')}
                      onClick={() => toggleExcludedApp(app)}
                    >
                      {excluded && <VolumeX size={14} aria-hidden />}
                      {app.name}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="screen-picker__hint">
              Discord e outros apps de chamada ficam fora por padrão. Clique num app para tirar ou devolver o som
              dele. A escolha fica salva.
            </p>
          </div>
        )}

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
