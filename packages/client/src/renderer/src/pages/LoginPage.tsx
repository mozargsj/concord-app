import { useState, type FormEvent } from 'react';
import type { UserProfile } from '@concord/shared';
import Button from '../components/Button';
import logo from '../assets/images/logo.png';
import { TEST_MODE, login } from '../lib/api';
import '../styles/LoginPage.css';

interface LoginPageProps {
  onContinue: (user: UserProfile, sessionToken: string) => void;
}

export default function LoginPage({ onContinue }: LoginPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testNickname, setTestNickname] = useState('');

  async function handleGoogleLogin() {
    setError(null);
    setIsSubmitting(true);
    try {
      const { email, displayName, avatarImageUrl } = await window.concord.auth.loginWithGoogle();
      const { user, sessionToken } = await login(email, displayName, avatarImageUrl);
      onContinue(user, sessionToken);
    } catch {
      setError('Não foi possível entrar com o Google. Tente novamente.');
    } finally {
      setIsSubmitting(false);
    }
  }

  // [MODO TESTE — TEMPORÁRIO] Sem validação de propósito, é só pra navegar o app enquanto o
  // OAuth/backend real não estão testáveis ponta-a-ponta (bloqueio de AWS). Tirar junto com
  // VITE_TEST_MODE quando a versão estável (com AWS funcionando) chegar.
  async function handleTestLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!testEmail.trim() || !testNickname.trim()) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const { user, sessionToken } = await login(testEmail.trim(), testNickname.trim());
      onContinue(user, sessionToken);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-page__card">
        <img src={logo} alt="Concord" className="login-page__logo" />
        <h1 className="login-page__title">Concord</h1>
        <p className="login-page__subtitle">Áudio ao vivo e transmissão de tela, P2P.</p>

        {TEST_MODE ? (
          <form className="login-page__form" onSubmit={handleTestLogin}>
            <p className="login-page__test-banner">Modo teste — sem Google, sem validação.</p>
            <input
              className="login-page__input"
              placeholder="Email"
              value={testEmail}
              onChange={(event) => setTestEmail(event.target.value)}
              autoFocus
            />
            <input
              className="login-page__input"
              placeholder="Nickname"
              value={testNickname}
              onChange={(event) => setTestNickname(event.target.value)}
            />
            <Button className="login-page__google-button" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Entrando…' : 'Entrar (teste)'}
            </Button>
          </form>
        ) : (
          <Button className="login-page__google-button" onClick={handleGoogleLogin} disabled={isSubmitting}>
            {isSubmitting ? 'Entrando…' : 'Entrar com Google'}
          </Button>
        )}

        {error && <p className="login-page__error">{error}</p>}
      </div>
    </div>
  );
}
