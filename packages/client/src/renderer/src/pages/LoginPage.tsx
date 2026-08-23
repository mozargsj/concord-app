import { useState } from 'react';
import type { UserProfile } from '@concord/shared';
import Button from '../components/Button';
import logo from '../assets/images/logo.svg';
import { login } from '../lib/api';
import '../styles/LoginPage.css';

interface LoginPageProps {
  onContinue: (user: UserProfile, sessionToken: string) => void;
}

export default function LoginPage({ onContinue }: LoginPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  return (
    <div className="login-page">
      <div className="login-page__card">
        <img src={logo} alt="Concord" className="login-page__logo" />
        <h1 className="login-page__title">Concord</h1>
        <p className="login-page__subtitle">Áudio ao vivo e transmissão de tela, P2P.</p>

        <Button className="login-page__google-button" onClick={handleGoogleLogin} disabled={isSubmitting}>
          {isSubmitting ? 'Entrando…' : 'Entrar com Google'}
        </Button>

        {error && <p className="login-page__error">{error}</p>}
      </div>
    </div>
  );
}
