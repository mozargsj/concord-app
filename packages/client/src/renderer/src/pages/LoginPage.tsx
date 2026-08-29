import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { UserProfile } from '@concord/shared';
import Button from '../components/Button';
import LoginFailedModal from '../components/LoginFailedModal';
import logo from '../assets/images/logo.png';
import { TEST_MODE, login } from '../lib/api';
import { clearStoredTestIdentity, getStoredTestIdentity, setStoredTestIdentity } from '../lib/testIdentity';
import '../styles/LoginPage.css';

interface LoginPageProps {
  onContinue: (user: UserProfile, sessionToken: string) => void;
}

export default function LoginPage({ onContinue }: LoginPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testNickname, setTestNickname] = useState('');
  const hasAutoLoggedIn = useRef(false);

  async function handleGoogleLogin() {
    setError(null);
    setIsSubmitting(true);
    try {
      const { email, displayName, avatarImageUrl, idToken } = await window.concord.auth.loginWithGoogle();
      const { user, sessionToken } = await login(email, displayName, idToken, avatarImageUrl);
      onContinue(user, sessionToken);
    } catch (err) {
      // The loopback server (main/googleAuth.ts) only ever hears back if the browser actually
      // completes the redirect — closing the tab instead leaves it waiting on nothing but its own
      // timeout, which is the only way that case ever resolves. Worth a distinct message instead
      // of the generic one, since "tente novamente" reads oddly for "you closed it yourself".
      const timedOut = err instanceof Error && err.message.includes('google-oauth-timeout');
      setError(
        timedOut
          ? 'Deu tempo esgotado esperando você terminar o login no navegador. Se fechou a aba sem querer, é só tentar de novo.'
          : 'Não foi possível entrar com o Google. Tente novamente.'
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  // [MODO TESTE — TEMPORÁRIO] Sem validação de propósito, é só pra navegar o app enquanto o
  // OAuth/backend real não estão testáveis ponta-a-ponta (bloqueio de AWS). Tirar junto com
  // VITE_TEST_MODE quando a versão estável (com AWS funcionando) chegar.
  async function performTestLogin(email: string, nickname: string) {
    setError(null);
    setIsSubmitting(true);
    try {
      // TEST_MODE short-circuits before idToken is ever used for anything real (api.ts) — this
      // path never talks to a real backend, so there's nothing genuine to send.
      const { user, sessionToken } = await login(email, nickname, 'test-mode-id-token');
      setStoredTestIdentity({ email, nickname });
      onContinue(user, sessionToken);
    } finally {
      setIsSubmitting(false);
    }
  }

  // Auto-login with whatever test identity was saved from a previous run — the whole point is
  // not having to retype it every time the test build opens. Runs once; hasAutoLoggedIn guards
  // against React 18 StrictMode's double-invoke of effects in dev re-running the login.
  useEffect(() => {
    if (!TEST_MODE || hasAutoLoggedIn.current) return;
    const stored = getStoredTestIdentity();
    if (!stored) return;
    hasAutoLoggedIn.current = true;
    setTestEmail(stored.email);
    setTestNickname(stored.nickname);
    void performTestLogin(stored.email, stored.nickname);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on mount
  }, []);

  function handleTestLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!testEmail.trim() || !testNickname.trim()) return;
    void performTestLogin(testEmail.trim(), testNickname.trim());
  }

  function handleForgetTestIdentity() {
    clearStoredTestIdentity();
    setTestEmail('');
    setTestNickname('');
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
            {(testEmail || testNickname) && (
              <button type="button" className="login-page__forget-test" onClick={handleForgetTestIdentity}>
                Trocar conta de teste
              </button>
            )}
          </form>
        ) : (
          <Button className="login-page__google-button" onClick={handleGoogleLogin} disabled={isSubmitting}>
            {isSubmitting ? 'Entrando…' : 'Entrar com Google'}
          </Button>
        )}

      </div>

      {error && (
        <LoginFailedModal
          detail={error}
          onBack={() => setError(null)}
          onCancel={() => window.concord.windowControls.close()}
        />
      )}
    </div>
  );
}
