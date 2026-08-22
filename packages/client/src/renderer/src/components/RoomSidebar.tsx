import type { RoomSummary, ServerSummary } from '@concord/shared';
import UserPanel from './UserPanel';
import chevronDownIcon from '../assets/icons/chevron-down.svg';
import userPlusIcon from '../assets/icons/user-plus.svg';
import plusIcon from '../assets/icons/plus.svg';
import speakerIcon from '../assets/icons/speaker.svg';
import { mockCurrentUser, mockParticipantsByRoom } from '../fixtures/mockData';
import { getAvatarColor } from '../lib/avatarColor';
import '../styles/RoomSidebar.css';

interface RoomSidebarProps {
  server: ServerSummary;
  rooms: RoomSummary[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  isMicMuted: boolean;
  isDeafened: boolean;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  isSpeaking: boolean;
}

export default function RoomSidebar({
  server,
  rooms,
  selectedRoomId,
  onSelectRoom,
  isMicMuted,
  isDeafened,
  onToggleMic,
  onToggleDeafen,
  isSpeaking
}: RoomSidebarProps) {
  return (
    <aside className="room-sidebar">
      <header className="room-sidebar__header">
        <span className="room-sidebar__server-name">{server.name}</span>
        <div className="room-sidebar__header-actions">
          <button className="room-sidebar__icon-button" title="Convidar pessoas">
            <img src={userPlusIcon} alt="" />
          </button>
          <img src={chevronDownIcon} alt="" className="room-sidebar__chevron" />
        </div>
      </header>

      <div className="room-sidebar__rooms">
        <div className="room-sidebar__category">
          <div className="room-sidebar__category-label">
            <img src={chevronDownIcon} alt="" className="room-sidebar__category-chevron" />
            <span>Canais de Voz</span>
          </div>
          <button className="room-sidebar__icon-button" title="Criar sala">
            <img src={plusIcon} alt="" />
          </button>
        </div>

        {rooms.map((room) => {
          const others = mockParticipantsByRoom[room.id] ?? [];
          const isJoined = room.id === selectedRoomId;
          const participants = isJoined ? [mockCurrentUser.displayName, ...others] : others;

          return (
            <div key={room.id} className="room-sidebar__room-block">
              <button
                className={'room-sidebar__room' + (isJoined ? ' room-sidebar__room--active' : '')}
                onClick={() => onSelectRoom(room.id)}
              >
                <img src={speakerIcon} alt="" className="room-sidebar__room-icon" />
                <span className="room-sidebar__room-name">{room.name}</span>
                <span className="room-sidebar__room-count">
                  {room.memberCount}/{room.maxMembers}
                </span>
              </button>

              {participants.length > 0 && (
                <div className="room-sidebar__participants">
                  {participants.map((name, participantIndex) => {
                    const isSelf = isJoined && participantIndex === 0;
                    return (
                      <div key={name} className="room-sidebar__participant">
                        <span
                          className={
                            'room-sidebar__participant-avatar' +
                            (isSelf && isSpeaking ? ' room-sidebar__participant-avatar--speaking' : '')
                          }
                          style={{ background: getAvatarColor(name) }}
                        >
                          {name.charAt(0)}
                        </span>
                        <span className="room-sidebar__participant-name">{name}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <UserPanel
        isMicMuted={isMicMuted}
        isDeafened={isDeafened}
        onToggleMic={onToggleMic}
        onToggleDeafen={onToggleDeafen}
      />
    </aside>
  );
}
