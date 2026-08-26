import Button from './Button';
import IllustratedNotice from './IllustratedNotice';
import falhaLoginArt from '../assets/images/falha_login.png';
import { LOGIN_FAILED_MESSAGES } from '../lib/errorMessages';
import '../styles/LoginFailedModal.css';

interface LoginFailedModalProps {
  detail: string;
  /** Dismisses the modal, back to LoginPage in its normal state — ready to try again. */
  onBack: () => void;
  /** Goes through the same window-close flow as the titlebar's close button (window:close IPC →
   * the intercepted `close` event → App.tsx's existing "Fechar Concord" confirmation) — quitting
   * from here isn't a separate, unconfirmed exit path, it's the one that already exists. */
  onCancel: () => void;
}

/** Login failure gets a modal instead of an inline notice under the button (unlike the other
 * IllustratedNotice call sites, which are all "one thing failed, the rest of the screen still
 * works") — LoginPage has nothing else usable behind it while logged out, so this reads more like
 * a blocking decision point: try again, or leave. */
export default function LoginFailedModal({ detail, onBack, onCancel }: LoginFailedModalProps) {
  return (
    <div className="login-failed-modal__backdrop" onClick={onBack}>
      <div className="login-failed-modal" onClick={(event) => event.stopPropagation()}>
        <header className="login-failed-modal__header">
          <h2>Falha no login</h2>
        </header>

        <IllustratedNotice icon={falhaLoginArt} messages={LOGIN_FAILED_MESSAGES} detail={detail} layout="column" />

        <div className="login-failed-modal__actions">
          <Button variant="danger" onClick={onCancel}>
            Cancelar
          </Button>
          <Button onClick={onBack}>Voltar</Button>
        </div>
      </div>
    </div>
  );
}
