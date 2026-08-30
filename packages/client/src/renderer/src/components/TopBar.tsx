import { Volume2, MessageSquare } from 'lucide-react';
import '../styles/TopBar.css';

interface TopBarProps {
  roomName: string | null;
  isChatOpen: boolean;
  onToggleChat: () => void;
}

export default function TopBar({ roomName, isChatOpen, onToggleChat }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar__room">
        {roomName && <Volume2 size={18} className="top-bar__room-icon" />}
        <span className="top-bar__room-name">{roomName ?? 'Nenhuma sala selecionada'}</span>
      </div>

      {roomName && (
        <button
          className={'top-bar__icon-button' + (isChatOpen ? ' top-bar__icon-button--active' : '')}
          title="Conversa por texto"
          onClick={onToggleChat}
        >
          <MessageSquare size={18} />
        </button>
      )}
    </header>
  );
}
