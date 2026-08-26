import { useState } from 'react';
import sessionExpiredArt from '../assets/images/session-expired.png';
import Button from './Button';
import '../styles/FullScreenNotice.css';

interface SessionExpiredScreenProps {
  onContinue: () => void;
}

// Same rotation pattern as ServerOfflineScreen (decisions.md keeps the full copy bank) — one
// picked per mount, not per render.
const MESSAGES = [
  'Sua sessão cochilou e dormiu além da conta. Entra de novo pra acordar ela.',
  'O tempo da sua sessão acabou enquanto o Mingau tirava uma soneca.',
  'Sessão expirada — nem o despertador do gato deu conta dessa vez.'
];

/** Shown when a stored session token is rejected — either at boot (restoring a stale token) or
 * mid-session (any authenticated request 401s while the app is open, via api.ts's
 * setUnauthorizedHandler). Unlike ServerOfflineScreen there's nothing to retry here — the token
 * itself is gone, so the only way forward is logging in again. */
export default function SessionExpiredScreen({ onContinue }: SessionExpiredScreenProps) {
  const [message] = useState(() => MESSAGES[Math.floor(Math.random() * MESSAGES.length)]);

  return (
    <div className="full-screen-notice">
      <img src={sessionExpiredArt} alt="" className="full-screen-notice__icon" />
      <h2 className="full-screen-notice__title">Sua sessão expirou</h2>
      <p className="full-screen-notice__message">{message}</p>
      <Button onClick={onContinue}>Entrar novamente</Button>
    </div>
  );
}
