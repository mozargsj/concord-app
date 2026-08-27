import { useEffect, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';
import logo from '../assets/images/logo.png';
import DonateModal from './DonateModal';
import '../styles/TitleBar.css';

interface TitleBarProps {
  title: string;
}

export default function TitleBar({ title }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isDonateOpen, setIsDonateOpen] = useState(false);

  useEffect(() => {
    return window.concord?.windowControls.onMaximizedChange(setIsMaximized);
  }, []);

  return (
    <>
      <header className="title-bar">
      <div className="title-bar__left">
        <span className="title-bar__version">v{__APP_VERSION__}</span>
      </div>

      <div className="title-bar__center">
        <img src={logo} alt="" className="title-bar__logo" />
        <span className="title-bar__title">{title}</span>
      </div>

      <div className="title-bar__actions">
        <button className="title-bar__donate" onClick={() => setIsDonateOpen(true)}>
          DONATE
        </button>

        <div className="title-bar__divider" />

        <button
          className="title-bar__window-button"
          title="Minimizar"
          onClick={() => window.concord?.windowControls.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          className="title-bar__window-button"
          title={isMaximized ? 'Restaurar' : 'Maximizar'}
          onClick={() => window.concord?.windowControls.maximizeToggle()}
        >
          <Square size={12} />
        </button>
        <button
          className="title-bar__window-button title-bar__window-button--close"
          title="Fechar"
          onClick={() => window.concord?.windowControls.close()}
        >
          <X size={14} />
        </button>
      </div>
      </header>

      {isDonateOpen && <DonateModal onClose={() => setIsDonateOpen(false)} />}
    </>
  );
}
