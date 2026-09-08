import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Download, Minus, Square, X } from 'lucide-react';
import logo from '../assets/images/logo.png';
import DonateModal from './DonateModal';
import '../styles/TitleBar.css';

interface TitleBarProps {
  title: string;
  /** Set once the server pushes an "update available" notification while the app is already open
   * (App.tsx's subscribeToUpdateNotifications) — null means nothing pending. This icon is the
   * persistent affordance (stays until the update is authorized or a new one arrives), separate
   * from UpdateToast's one-time dismissable balloon — both call the same onRequestUpdate. */
  pendingUpdateVersion: string | null;
  onRequestUpdate: () => void;
}

export default function TitleBar({ title, pendingUpdateVersion, onRequestUpdate }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isDonateOpen, setIsDonateOpen] = useState(false);

  useEffect(() => {
    return window.concord?.windowControls.onMaximizedChange(setIsMaximized);
  }, []);

  // Manual window-drag, replacing `-webkit-app-region: drag` — see TitleBar.css's `.title-bar`
  // comment for why. Ignores anything that starts on a button (window controls, donate) so those
  // keep working as normal clicks instead of being swallowed by the drag gesture.
  function handleMouseDown(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;

    window.concord?.windowControls.dragStart(event.screenX, event.screenY);

    const handleMove = (moveEvent: MouseEvent) => {
      window.concord?.windowControls.dragMove(moveEvent.screenX, moveEvent.screenY);
    };
    const handleUp = () => {
      window.concord?.windowControls.dragEnd();
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('button')) return;
    window.concord?.windowControls.maximizeToggle();
  }

  return (
    <>
      <header className="title-bar" onMouseDown={handleMouseDown} onDoubleClick={handleDoubleClick}>
      <div className="title-bar__left">
        {/* Own span, not nested inside .title-bar__version — that one runs at opacity:0.6, which
            would flatten this tag's color right along with it (opacity dims the whole subtree, a
            child's own opacity:1 can't undo that) and defeat the point of a color you can
            actually tell apart at a glance. */}
        <span className={`title-bar__build-tag title-bar__build-tag--${__APP_BUILD_TAG__}`}>
          {__APP_BUILD_TAG__}
        </span>
        <span className="title-bar__version">v{__APP_VERSION__}</span>
      </div>

      <div className="title-bar__center">
        <img src={logo} alt="" className="title-bar__logo" />
        <span className="title-bar__title">{title}</span>
      </div>

      <div className="title-bar__actions">
        {pendingUpdateVersion && (
          <button
            className="title-bar__update-available"
            title={`Nova versão disponível (${pendingUpdateVersion}) — clique pra atualizar`}
            onClick={onRequestUpdate}
          >
            <Download size={14} />
            <span className="title-bar__update-available-dot" />
          </button>
        )}

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
