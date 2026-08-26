import { useState } from 'react';
import semConexaoArt from '../assets/images/sem-conexao.png';
import reconnectingArt from '../assets/images/update-spinner.png';
import '../styles/FullScreenNotice.css';

interface NoInternetScreenProps {
  status: 'offline' | 'reconnecting';
}

// Same rotating-copy pattern as every other screen in this family (decisions.md) — one picked
// per mount, not per render.
const OFFLINE_MESSAGES = [
  'Parece que você esqueceu de pagar a internet esse mês. Verifique sua conexão e volte com a gente.',
  'Sua internet saiu pra passear e esqueceu de avisar. Confira a conexão.',
  'Cadê a internet? Ela não respondeu nem ao miado.'
];

/** Detects loss of the system's own network connectivity (ServerListPage.tsx, navigator.onLine +
 * online/offline events) — distinct from ServerOfflineScreen, which is about *our* server being
 * unreachable while the internet itself is fine. Fully automatic, no retry button: once the
 * browser fires 'online' again, ServerListPage re-checks real connectivity (GET /health, not just
 * the network interface) before declaring it fixed, then rejoins whatever room was active. */
export default function NoInternetScreen({ status }: NoInternetScreenProps) {
  const [message] = useState(() => OFFLINE_MESSAGES[Math.floor(Math.random() * OFFLINE_MESSAGES.length)]);

  if (status === 'reconnecting') {
    return (
      <div className="full-screen-notice">
        <img src={reconnectingArt} alt="" className="full-screen-notice__icon" />
        <h2 className="full-screen-notice__title">Conexão de volta — confirmando...</h2>
        <p className="full-screen-notice__message">Já já te levamos de volta pra sala, só confirmando que está tudo certo.</p>
      </div>
    );
  }

  return (
    <div className="full-screen-notice">
      <img src={semConexaoArt} alt="" className="full-screen-notice__icon" />
      <h2 className="full-screen-notice__title">Sem internet</h2>
      <p className="full-screen-notice__message">{message}</p>
    </div>
  );
}
