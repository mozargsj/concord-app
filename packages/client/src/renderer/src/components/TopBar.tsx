import speakerIcon from '../assets/icons/speaker.svg';
import chatBubbleIcon from '../assets/icons/chat-bubble.svg';
import '../styles/TopBar.css';

interface TopBarProps {
  roomName: string | null;
}

export default function TopBar({ roomName }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="top-bar__room">
        {roomName && <img src={speakerIcon} alt="" className="top-bar__room-icon" />}
        <span className="top-bar__room-name">{roomName ?? 'Nenhuma sala selecionada'}</span>
      </div>

      {roomName && (
        <button className="top-bar__icon-button" title="Conversa por texto">
          <img src={chatBubbleIcon} alt="" />
        </button>
      )}
    </header>
  );
}
