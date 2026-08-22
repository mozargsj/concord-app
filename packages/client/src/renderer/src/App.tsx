import { useState } from 'react';
import TitleBar from './components/TitleBar';
import LoginPage from './pages/LoginPage';
import ServerListPage from './pages/ServerListPage';
import './styles/App.css';

type View = 'login' | 'app';

export default function App() {
  const [view, setView] = useState<View>('login');
  const [activeServerName, setActiveServerName] = useState('Concord');

  return (
    <div className="app-shell">
      <TitleBar title={activeServerName} />
      <div className="app-shell__content">
        {view === 'login' ? (
          <LoginPage onContinue={() => setView('app')} />
        ) : (
          <ServerListPage onActiveServerChange={setActiveServerName} />
        )}
      </div>
    </div>
  );
}
