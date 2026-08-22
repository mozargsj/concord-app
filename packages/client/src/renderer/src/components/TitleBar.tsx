import { useEffect, useState } from 'react';
import logo from '../assets/images/logo.svg';
import arrowLeftIcon from '../assets/icons/arrow-left.svg';
import arrowRightIcon from '../assets/icons/arrow-right.svg';
import castIcon from '../assets/icons/cast.svg';
import helpIcon from '../assets/icons/help.svg';
import downloadIcon from '../assets/icons/download.svg';
import minimizeIcon from '../assets/icons/window-minimize.svg';
import maximizeIcon from '../assets/icons/window-maximize.svg';
import closeIcon from '../assets/icons/window-close.svg';
import '../styles/TitleBar.css';

interface TitleBarProps {
  title: string;
}

export default function TitleBar({ title }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    return window.concord?.windowControls.onMaximizedChange(setIsMaximized);
  }, []);

  return (
    <header className="title-bar">
      <div className="title-bar__nav">
        <button className="title-bar__icon-button" title="Voltar">
          <img src={arrowLeftIcon} alt="" />
        </button>
        <button className="title-bar__icon-button" title="Avançar">
          <img src={arrowRightIcon} alt="" />
        </button>
      </div>

      <div className="title-bar__center">
        <img src={logo} alt="" className="title-bar__logo" />
        <span className="title-bar__title">{title}</span>
      </div>

      <div className="title-bar__actions">
        <button className="title-bar__icon-button" title="Transmitir">
          <img src={castIcon} alt="" />
        </button>
        <button className="title-bar__icon-button" title="Ajuda">
          <img src={helpIcon} alt="" />
        </button>
        <button className="title-bar__icon-button title-bar__icon-button--accent" title="Atualização disponível">
          <img src={downloadIcon} alt="" />
        </button>

        <div className="title-bar__divider" />

        <button
          className="title-bar__window-button"
          title="Minimizar"
          onClick={() => window.concord?.windowControls.minimize()}
        >
          <img src={minimizeIcon} alt="" />
        </button>
        <button
          className="title-bar__window-button"
          title={isMaximized ? 'Restaurar' : 'Maximizar'}
          onClick={() => window.concord?.windowControls.maximizeToggle()}
        >
          <img src={maximizeIcon} alt="" />
        </button>
        <button
          className="title-bar__window-button title-bar__window-button--close"
          title="Fechar"
          onClick={() => window.concord?.windowControls.close()}
        >
          <img src={closeIcon} alt="" />
        </button>
      </div>
    </header>
  );
}
