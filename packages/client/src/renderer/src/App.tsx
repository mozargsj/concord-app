import { useEffect, useState } from 'react';
import type { UserProfile } from '@concord/shared';
import type { UpdatePhase, UpdateStatusInfo } from './types/window';
import TitleBar from './components/TitleBar';
import ConfirmModal from './components/ConfirmModal';
import LoadingSpinner from './components/LoadingSpinner';
import updateSpinnerIcon from './assets/images/update-spinner.png';
import ServerOfflineScreen from './components/ServerOfflineScreen';
import SessionExpiredScreen from './components/SessionExpiredScreen';
import LoginPage from './pages/LoginPage';
import ServerListPage from './pages/ServerListPage';
import {
  TEST_MODE,
  checkServerHealth,
  getCurrentUser,
  setSessionToken,
  setUnauthorizedHandler
} from './lib/api';
import { clearStoredSessionToken, getStoredSessionToken, setStoredSessionToken } from './lib/session';
import { clearStoredTestIdentity } from './lib/testIdentity';
import { loadCachedImage } from './lib/imageCache';
import './styles/App.css';

type View = 'loading' | 'offline' | 'session-expired' | 'login' | 'app';

// While the offline screen is up, keep quietly probing in the background so the app recovers on
// its own the moment the server comes back — the "Tentar novamente" button covers the impatient
// path, this covers "left it open and walked away".
const OFFLINE_RETRY_INTERVAL_MS = 5000;

export default function App() {
  const [view, setView] = useState<View>('loading');
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [activeServerName, setActiveServerName] = useState('Concord');
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);
  const [isRetryingConnection, setIsRetryingConnection] = useState(false);
  // 'checking' at startup, every launch — no prompt either way: 'done' (nothing found, or an
  // error) just falls through to the normal boot below; 'updating' means main is silently
  // downloading and will relaunch on its own once ready (see main/autoUpdate.ts), so the normal
  // session check is held off until then. 'phase'/'percent'/'version' drive the dynamic message
  // below instead of one static "sendo atualizado" screen with no information.
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusInfo>({ status: 'checking' });

  useEffect(() => {
    return window.concord?.app.onConfirmCloseRequest(() => setIsCloseConfirmOpen(true));
  }, []);

  useEffect(() => {
    return window.concord?.app.onUpdateStatus(setUpdateStatus);
  }, []);

  // Single global catch for "the session is no longer valid" — fires from api.ts's request()
  // choke point on any 401 that had a token attached, whether that happens restoring a stale
  // token at boot or mid-session while the app is already open and in use.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSessionToken(null);
      void clearStoredSessionToken();
      setCurrentUser(null);
      setView('session-expired');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // The backend's avatarUrl may be null (nothing persisted server-side — avatars are P2P-only
  // now, see decisions.md) even though this is my own account and the file is sitting right
  // here in my disk cache from a previous pick.
  async function hydrateOwnAvatar(user: UserProfile): Promise<UserProfile> {
    if (user.avatarUrl) return user;
    const cached = await loadCachedImage('avatar', user.id);
    return cached ? { ...user, avatarUrl: cached.url } : user;
  }

  // Gates both paths below (session restore and a fresh login) on the server actually being
  // reachable first — neither works without it, and failing fast into a dedicated screen beats
  // LoginPage timing out its own Google OAuth call or getCurrentUser() rejecting deep in a .then.
  async function bootstrap(): Promise<void> {
    const isOnline = await checkServerHealth();
    if (!isOnline) {
      setView('offline');
      return;
    }

    const token = await getStoredSessionToken();
    if (!token) {
      setView('login');
      return;
    }
    setSessionToken(token);
    try {
      const user = await hydrateOwnAvatar(await getCurrentUser());
      setCurrentUser(user);
      setView('app');
    } catch {
      // A 401 here already ran the global unauthorized handler above (cleared the token, switched
      // to 'session-expired') — don't clobber that. Any other failure (network hiccup mid-boot,
      // malformed response) falls back to a plain login screen instead of an infinite spinner.
      setSessionToken(null);
      void clearStoredSessionToken();
      setView((current) => (current === 'session-expired' ? current : 'login'));
    }
  }

  useEffect(() => {
    if (updateStatus.status !== 'done') return;
    void bootstrap();
  }, [updateStatus.status]);

  // Offline screen keeps probing quietly in the background, on top of the manual "Tentar
  // novamente" button — recovers on its own if left open after the server comes back.
  useEffect(() => {
    if (view !== 'offline') return;
    const interval = setInterval(() => void bootstrap(), OFFLINE_RETRY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [view]);

  function handleRetryConnection(): void {
    setIsRetryingConnection(true);
    void bootstrap().finally(() => setIsRetryingConnection(false));
  }

  function describeUpdatePhase(phase: UpdatePhase | undefined, version: string | undefined): string {
    switch (phase) {
      case 'checking':
        return 'Verificando atualizações...';
      case 'available':
        return version ? `Nova versão encontrada (${version})...` : 'Nova versão encontrada...';
      case 'downloading':
        return 'Baixando atualização...';
      case 'installing':
        return version ? `Instalando a versão ${version}...` : 'Instalando atualização...';
      default:
        return 'O Concord está sendo atualizado, aguarde...';
    }
  }

  function handleLoggedIn(user: UserProfile, sessionToken: string): void {
    setSessionToken(sessionToken);
    setStoredSessionToken(sessionToken);
    setCurrentUser(user);
    setView('app');
    void hydrateOwnAvatar(user).then(setCurrentUser);
  }

  // Unmounting ServerListPage (view leaving 'app') tears down any active room connection through
  // its own effect cleanup (stops mic/camera, closes the mesh + signaling socket) — same cleanup
  // path already relied on for the close-app flow, nothing extra needed here for that part.
  function handleLogout(): void {
    setSessionToken(null);
    void clearStoredSessionToken();
    // [MODO TESTE] Without this, LoginPage's own stored-identity auto-login effect re-logs in
    // instantly on remount — logout would look like it did nothing but leave the room. An
    // explicit sign-out should stick even in test mode; real Google login has no equivalent
    // auto-login to worry about.
    if (TEST_MODE) clearStoredTestIdentity();
    setCurrentUser(null);
    setView('login');
  }

  return (
    <div className="app-shell">
      <TitleBar title={activeServerName} />
      <div className="app-shell__content">
        {updateStatus.status !== 'done' ? (
          <LoadingSpinner
            message={describeUpdatePhase(updateStatus.phase, updateStatus.version)}
            percent={updateStatus.phase === 'downloading' ? updateStatus.percent : undefined}
            icon={updateSpinnerIcon}
          />
        ) : (
          view === 'loading' && <LoadingSpinner />
        )}
        {view === 'offline' && (
          <ServerOfflineScreen onRetry={handleRetryConnection} isRetrying={isRetryingConnection} />
        )}
        {view === 'session-expired' && <SessionExpiredScreen onContinue={() => setView('login')} />}
        {view === 'login' && <LoginPage onContinue={handleLoggedIn} />}
        {view === 'app' && currentUser && (
          <ServerListPage
            currentUser={currentUser}
            onCurrentUserChange={setCurrentUser}
            onActiveServerChange={setActiveServerName}
            onLogout={handleLogout}
          />
        )}
      </div>

      {isCloseConfirmOpen && (
        <ConfirmModal
          title="Fechar Concord"
          message="Tem certeza que deseja fechar o Concord? Isso encerra qualquer chamada em andamento."
          confirmLabel="Fechar"
          onCancel={() => {
            window.concord?.app.respondToCloseConfirmation(false);
            setIsCloseConfirmOpen(false);
          }}
          onConfirm={() => {
            window.concord?.app.respondToCloseConfirmation(true);
            setIsCloseConfirmOpen(false);
          }}
        />
      )}
    </div>
  );
}
