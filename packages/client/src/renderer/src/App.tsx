import { useEffect, useState } from 'react';
import type { UserProfile } from '@concord/shared';
import type { UpdateStatus } from './types/window';
import TitleBar from './components/TitleBar';
import ConfirmModal from './components/ConfirmModal';
import LoadingSpinner from './components/LoadingSpinner';
import LoginPage from './pages/LoginPage';
import ServerListPage from './pages/ServerListPage';
import { getCurrentUser, setSessionToken } from './lib/api';
import { clearStoredSessionToken, getStoredSessionToken, setStoredSessionToken } from './lib/session';
import { loadCachedImage } from './lib/imageCache';
import './styles/App.css';

type View = 'loading' | 'login' | 'app';

export default function App() {
  const [view, setView] = useState<View>('loading');
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [activeServerName, setActiveServerName] = useState('Concord');
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);
  // 'checking' at startup, every launch — no prompt either way: 'done' (nothing found, or an
  // error) just falls through to the normal boot below; 'updating' means main is silently
  // downloading and will relaunch on its own once ready (see main/autoUpdate.ts), so the normal
  // session check is held off until then.
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('checking');

  useEffect(() => {
    return window.concord?.app.onConfirmCloseRequest(() => setIsCloseConfirmOpen(true));
  }, []);

  useEffect(() => {
    return window.concord?.app.onUpdateStatus(setUpdateStatus);
  }, []);

  // The backend's avatarUrl may be null (nothing persisted server-side — avatars are P2P-only
  // now, see decisions.md) even though this is my own account and the file is sitting right
  // here in my disk cache from a previous pick.
  async function hydrateOwnAvatar(user: UserProfile): Promise<UserProfile> {
    if (user.avatarUrl) return user;
    const cached = await loadCachedImage('avatar', user.id);
    return cached ? { ...user, avatarUrl: cached.url } : user;
  }

  useEffect(() => {
    if (updateStatus !== 'done') return;
    getStoredSessionToken().then((token) => {
      if (!token) {
        setView('login');
        return;
      }
      setSessionToken(token);
      getCurrentUser()
        .then((user) => hydrateOwnAvatar(user))
        .then((user) => {
          setCurrentUser(user);
          setView('app');
        })
        .catch(() => {
          setSessionToken(null);
          clearStoredSessionToken();
          setView('login');
        });
    });
  }, [updateStatus]);

  function handleLoggedIn(user: UserProfile, sessionToken: string): void {
    setSessionToken(sessionToken);
    setStoredSessionToken(sessionToken);
    setCurrentUser(user);
    setView('app');
    void hydrateOwnAvatar(user).then(setCurrentUser);
  }

  return (
    <div className="app-shell">
      <TitleBar title={activeServerName} />
      <div className="app-shell__content">
        {updateStatus === 'updating' ? (
          <LoadingSpinner message="O Concord está sendo atualizado, aguarde..." />
        ) : (
          view === 'loading' && <LoadingSpinner />
        )}
        {view === 'login' && <LoginPage onContinue={handleLoggedIn} />}
        {view === 'app' && currentUser && (
          <ServerListPage
            currentUser={currentUser}
            onCurrentUserChange={setCurrentUser}
            onActiveServerChange={setActiveServerName}
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
