import { PhoneOff } from 'lucide-react';
import { getLatencyBand } from '../lib/latency';
import '../styles/VoiceConnectionStatus.css';

interface VoiceConnectionStatusProps {
  serverName: string;
  roomName: string;
  latencyMs: number;
  onLeave: () => void;
}

export default function VoiceConnectionStatus({
  serverName,
  roomName,
  latencyMs,
  onLeave
}: VoiceConnectionStatusProps) {
  const band = getLatencyBand(latencyMs);

  return (
    <div className={`voice-status voice-status--${band}`}>
      {/* Inline (not <img src>) on purpose — it needs to pick up the band color via
          currentColor, which an externally-loaded SVG image can't inherit from CSS. */}
      <svg className="voice-status__signal" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 16.5C7 12 17 12 20 16.5"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.45"
        />
        <path
          d="M7 18.2C9.2 15 14.8 15 17 18.2"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.75"
        />
        <circle cx="12" cy="20" r="1.6" fill="currentColor" />
      </svg>

      <div className="voice-status__info">
        <span className="voice-status__title">Voz conectada</span>
        <span className="voice-status__subtitle">
          {serverName} / {roomName}
        </span>
      </div>

      <span className="voice-status__latency">{Math.round(latencyMs)} ms</span>

      <button className="voice-status__hangup" title="Desconectar" onClick={onLeave}>
        <PhoneOff size={16} />
      </button>
    </div>
  );
}
