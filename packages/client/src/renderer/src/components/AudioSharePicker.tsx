import { useEffect, useState } from 'react';
import { Music2, X } from 'lucide-react';
import SmartAppControlHint from './SmartAppControlHint';
import Tooltip from './Tooltip';
import { listAudioSessions } from '../lib/processLoopbackAudio';
import '../styles/AudioSharePicker.css';

interface AudioSession {
  pid: number;
  name: string;
}

interface AudioSharePickerProps {
  onSelect: (session: AudioSession) => void;
  onClose: () => void;
}

// [Bug relatado pelo Mozar] Spotify pausado não aparecia na lista, e não tinha como atualizar
// sem fechar e reabrir o seletor — a sessão WASAPI só existe como "ativa" enquanto o app está de
// fato emitindo som (ver ListAudioSessions em process_loopback.cc), então dar play depois de abrir
// o seletor não bastava. Um poll baixo o bastante pra não pesar (a própria enumeração já é
// sub-100ms) resolve sem precisar mudar o filtro nativo de "só sessão ativa".
const REFRESH_INTERVAL_MS = 1500;

/**
 * "Compartilhar áudio" — mesmo formato de modal do ScreenSharePicker.tsx, mas escolhendo um
 * processo em vez de uma tela/janela (pedido do Mozar, 2026-08-30): a lista vem do addon nativo
 * (process_loopback.cc's ListAudioSessions, WASAPI IAudioSessionEnumerator) — só apps com uma
 * sessão de áudio ativa agora, o Concord fica de fora da própria lista. Windows-only, mesma
 * limitação de todo o recurso de process-loopback.
 */
export default function AudioSharePicker({ onSelect, onClose }: AudioSharePickerProps) {
  const [sessions, setSessions] = useState<AudioSession[] | null>(null);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  // Only checked when the addon fails to load — distinguishes "blocked by Smart App Control"
  // (has a fix, shows the hint) from "unsupported Windows version" (no fix to offer).
  const [isSacActive, setIsSacActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.concord.processLoopback
      .isAvailable()
      .then((available) => {
        if (cancelled) return;
        setIsAvailable(available);
        if (!available) {
          setSessions([]);
          void window.concord.smartAppControl.isActive().then((active) => {
            if (!cancelled) setIsSacActive(active);
          });
          return;
        }
        return listAudioSessions().then((result) => {
          if (!cancelled) setSessions(result);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setIsAvailable(false);
          setSessions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reconsulta enquanto o seletor fica aberto — pega quem começou a tocar (ou pausou) depois da
  // consulta inicial, sem exigir que a pessoa feche e reabra o modal. Some silenciosamente com
  // quem some da lista (ex. pausou); se era o selecionado, cai a seleção junto — melhor do que
  // deixar "Compartilhar" habilitado apontando pra um pid que não está mais tocando nada.
  useEffect(() => {
    if (!isAvailable) return;
    const interval = setInterval(() => {
      listAudioSessions().then((result) => {
        setSessions(result);
        setSelectedPid((prev) => (prev !== null && result.some((s) => s.pid === prev) ? prev : null));
      });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isAvailable]);

  const selectedSession = sessions?.find((session) => session.pid === selectedPid) ?? null;

  return (
    <div className="audio-picker__backdrop" onClick={onClose}>
      <div className="audio-picker" onClick={(event) => event.stopPropagation()}>
        <header className="audio-picker__header">
          <h2>Compartilhar áudio</h2>
          <Tooltip label="Fechar">
            <button className="audio-picker__close" onClick={onClose}>
              <X size={18} />
            </button>
          </Tooltip>
        </header>

        <p className="audio-picker__hint">
          Transmite só o áudio de um app escolhido — aparece na sala como "Music {'{'}seu nome{'}'}", com volume e
          mudo independentes da sua voz.
        </p>

        {isAvailable === false && isSacActive && (
          <div className="audio-picker__unavailable">
            <SmartAppControlHint text="Bloqueado pelo Smart App Control do Windows" />
          </div>
        )}

        {isAvailable === false && !isSacActive && (
          <p className="audio-picker__unavailable">
            Recurso indisponível neste PC (precisa do Windows 10 2004 ou mais recente).
          </p>
        )}

        {isAvailable !== false && sessions === null && <p className="audio-picker__hint">Procurando apps com áudio ativo…</p>}

        {isAvailable !== false && sessions !== null && sessions.length === 0 && (
          <p className="audio-picker__hint">Nenhum app tocando áudio agora — dê play em algo, a lista atualiza sozinha.</p>
        )}

        {sessions !== null && sessions.length > 0 && (
          <div className="audio-picker__body">
            <div className="audio-picker__grid">
              {sessions.map((session) => (
                <button
                  key={session.pid}
                  className={
                    'audio-picker__item' + (session.pid === selectedPid ? ' audio-picker__item--selected' : '')
                  }
                  onClick={() => setSelectedPid(session.pid)}
                >
                  <div className="audio-picker__item-icon-box">
                    <Music2 size={28} className="audio-picker__item-icon" />
                  </div>
                  <span className="audio-picker__item-name">{session.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <footer className="audio-picker__footer">
          <button
            className="audio-picker__confirm"
            disabled={!selectedSession}
            onClick={() => selectedSession && onSelect(selectedSession)}
          >
            Compartilhar
          </button>
        </footer>
      </div>
    </div>
  );
}
