import { useState } from 'react';
import serverOfflineArt from '../assets/images/server-offline.png';
import Button from './Button';
import '../styles/FullScreenNotice.css';

interface ServerOfflineScreenProps {
  onRetry: () => void;
  isRetrying: boolean;
}

// Same joke ("cat did it") told a few different ways — decisions.md keeps the full copy bank for
// every error screen in this family. One picked per mount, not per render, so it doesn't reshuffle
// mid-view on every retry tick.
const MESSAGES = [
  'Algum gato deve ter puxado os fios do servidor sem querer. Já mandamos alguém verificar — tenta de novo em instantes.',
  'O servidor tirou uma soneca sem avisar. Já fomos lá cutucar ele pra acordar.',
  'Sinal perdido entre o Concord e o servidor. Deve ser coisa de gato mesmo.'
];

/** Shown instead of LoginPage/ServerListPage when GET /health fails — gates both session restore
 * and a fresh Google login, since neither works without the server anyway (App.tsx checks health
 * before either path). */
export default function ServerOfflineScreen({ onRetry, isRetrying }: ServerOfflineScreenProps) {
  const [message] = useState(() => MESSAGES[Math.floor(Math.random() * MESSAGES.length)]);

  return (
    <div className="full-screen-notice">
      <img src={serverOfflineArt} alt="" className="full-screen-notice__icon" />
      <h2 className="full-screen-notice__title">Sem conexão com o servidor</h2>
      <p className="full-screen-notice__message">{message}</p>
      <Button onClick={onRetry} disabled={isRetrying}>
        {isRetrying ? 'Tentando...' : 'Tentar novamente'}
      </Button>
    </div>
  );
}
