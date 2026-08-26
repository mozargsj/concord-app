import { useState } from 'react';
import Button from './Button';
import IllustratedNotice from './IllustratedNotice';
import accessDeniedArt from '../assets/images/access-denied.png';
import { ACCESS_DENIED_MESSAGES } from '../lib/errorMessages';
import '../styles/InviteCodeModal.css';

interface InviteCodeModalProps {
  code: string | null;
  isLoading: boolean;
  error: string | null;
  isForbidden: boolean;
  onClose: () => void;
}

export default function InviteCodeModal({ code, isLoading, error, isForbidden, onClose }: InviteCodeModalProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard access denied — the code is still selectable/visible in the textarea
    }
  }

  return (
    <div className="invite-code-modal__backdrop" onClick={onClose}>
      <div className="invite-code-modal" onClick={(event) => event.stopPropagation()}>
        <header className="invite-code-modal__header">
          <h2>Convidar pessoas</h2>
          <button className="invite-code-modal__close" onClick={onClose} title="Fechar">
            ×
          </button>
        </header>

        {isLoading && <p className="invite-code-modal__hint">Gerando convite…</p>}
        {error && isForbidden && (
          <IllustratedNotice icon={accessDeniedArt} messages={ACCESS_DENIED_MESSAGES} detail={error} />
        )}
        {error && !isForbidden && <p className="invite-code-modal__error">{error}</p>}

        {code && (
          <>
            <p className="invite-code-modal__hint">
              Compartilhe esse código — quem colar em "Entrar com convite" entra no servidor.
              Válido por 7 dias.
            </p>
            <textarea className="invite-code-modal__code" readOnly value={code} onClick={(event) => event.currentTarget.select()} />
            <Button onClick={handleCopy}>{copied ? 'Copiado ✓' : 'Copiar código'}</Button>
          </>
        )}
      </div>
    </div>
  );
}
