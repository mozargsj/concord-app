import { useEffect, useState } from 'react';
import type { UserProfile } from '@concord/shared';
import TitleBar from './components/TitleBar';
import LoginPage from './pages/LoginPage';
import ServerListPage from './pages/ServerListPage';
import { getCurrentUser, setSessionToken } from './lib/api';
import { clearStoredSessionToken, getStoredSessionToken, setStoredSessionToken } from './lib/session';
import './styles/App.css';

type View = 'loading' | 'login' | 'app';

export default function App() {
  const [view, setView] = useState<View>('loading');
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [activeServerName, setActiveServerName] = useState('Concord');

  useEffect(() => {
    getStoredSessionToken().then((token) => {
      if (!token) {
        setView('login');
        return;
      }
      setSessionToken(token);
      getCurrentUser()
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
  }, []);

  function handleLoggedIn(user: UserProfile, sessionToken: string): void {
    setSessionToken(sessionToken);
    setStoredSessionToken(sessionToken);
    setCurrentUser(user);
    setView('app');
  }

  return (
    <div className="app-shell">
      <TitleBar title={activeServerName} />
      <div className="app-shell__content">
        {view === 'loading' && <div className="app-shell__loading" />}
        {view === 'login' && <LoginPage onContinue={handleLoggedIn} />}
        {view === 'app' && currentUser && (
          <ServerListPage
            currentUser={currentUser}
            onCurrentUserChange={setCurrentUser}
            onActiveServerChange={setActiveServerName}
          />
        )}
      </div>
    </div>
  );
}
