import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import Tooltip from './Tooltip';
import { getServerMember } from '../lib/api';
import { getAvatarColor } from '../lib/avatarColor';
import '../styles/ParticipantProfileModal.css';

interface ParticipantProfileModalProps {
  serverId: string;
  userId: string;
  /** Whatever name is currently showing in the room roster — shown as a fallback while the real
   * one loads, and as the loading-state placeholder if the fetch fails. Never trusted on its own:
   * the whole point of this modal is confirming the *real* name (see decisions.md, achado de
   * segurança sobre join-room). */
  fallbackName: string;
  avatarUrl: string | null;
  onClose: () => void;
}

/**
 * [2026-08-29, achado de segurança] Read-only — mostra o nickname real de outro membro do mesmo
 * servidor, buscado direto do D1 pelo userId (GET /servers/:id/members/:userId), nunca o que a
 * sinalização alegou no roster (que hoje já vem do D1 também — este modal existe pra deixar
 * qualquer inconsistência visível/auditável de propósito, não só corrigida silenciosamente).
 * Nunca mostra email — mesmo padrão de privacidade do resto do app (ProfilePage.tsx não exibe o
 * próprio email a ninguém).
 */
export default function ParticipantProfileModal({
  serverId,
  userId,
  fallbackName,
  avatarUrl,
  onClose
}: ParticipantProfileModalProps) {
  const [realName, setRealName] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getServerMember(serverId, userId)
      .then(({ displayName }) => {
        if (!cancelled) setRealName(displayName);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, userId]);

  const displayName = realName ?? fallbackName;

  return (
    <div className="participant-profile-modal__backdrop" onClick={onClose}>
      <div className="participant-profile-modal" onClick={(event) => event.stopPropagation()}>
        <Tooltip label="Fechar">
          <button className="participant-profile-modal__close" onClick={onClose}>
            <X size={18} />
          </button>
        </Tooltip>

        <div className="participant-profile-modal__avatar" style={avatarUrl ? undefined : { background: getAvatarColor(displayName) }}>
          {avatarUrl ? <img src={avatarUrl} alt="" /> : displayName.charAt(0).toUpperCase()}
        </div>

        {realName === null && !error ? (
          <div className="participant-profile-modal__loading">
            <Loader2 size={16} className="participant-profile-modal__spin" />
            <span>Confirmando nome…</span>
          </div>
        ) : (
          <span className="participant-profile-modal__name">{displayName}</span>
        )}

        {error && <p className="participant-profile-modal__error">Não foi possível confirmar o nome real agora.</p>}
      </div>
    </div>
  );
}
