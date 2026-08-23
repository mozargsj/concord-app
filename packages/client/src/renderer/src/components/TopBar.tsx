import { Volume2, MessageSquare } from 'lucide-react';
import '../styles/TopBar.css';

interface TopBarProps {
  roomName: string | null;
}

export default function TopBar({ roomName }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar__room">
        {roomName && <Volume2 size={18} className="top-bar__room-icon" />}
        <span className="top-bar__room-name">{roomName ?? 'Nenhuma sala selecionada'}</span>
      </div>

      {roomName && (
        <button className="top-bar__icon-button" title="Conversa por texto">
          <MessageSquare size={18} />
        </button>
      )}
    </header>
  );
}
