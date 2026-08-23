import type { RoomSummary, ServerSummary, UserProfile } from '@concord/shared';
import UserPanel from './UserPanel';
import VoiceConnectionStatus from './VoiceConnectionStatus';
import HostStarBadge from './HostStarBadge';
import chevronDownIcon from '../assets/icons/chevron-down.svg';
import userPlusIcon from '../assets/icons/user-plus.svg';
import plusIcon from '../assets/icons/plus.svg';
import speakerIcon from '../assets/icons/speaker.svg';
import { getAvatarColor } from '../lib/avatarColor';
import type { RoomPeer } from '../hooks/useRoomConnection';
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
  latencyMs: number;
  onLeave: () => void;
  selfPeerId: string | null;
  hostPeerId: string | null;
  peers: RoomPeer[];
  currentUser: UserProfile;
  onOpenProfile: () => void;
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
  isSpeaking,
  latencyMs,
  onLeave,
  selfPeerId,
  hostPeerId,
  peers,
  currentUser,
  onOpenProfile
}: RoomSidebarProps) {
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;
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
          const isJoined = room.id === selectedRoomId;
          // Real roster for the joined room, driven by signaling. Rooms the user hasn't
          // joined have no presence protocol yet (server only tracks membership for the
          // connected socket's own room), so they show no participant preview.
          const participants: { key: string; name: string; isSelf: boolean; isHost: boolean }[] = isJoined
            ? [
                {
                  key: 'self',
                  name: currentUser.displayName,
                  isSelf: true,
                  isHost: selfPeerId !== null && selfPeerId === hostPeerId
                },
                ...peers.map((peer) => ({
                  key: peer.peerId,
                  name: peer.displayName,
                  isSelf: false,
                  isHost: peer.peerId === hostPeerId
                }))
              ]
            : [];

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
                  {participants.map((participant) => (
                    <div key={participant.key} className="room-sidebar__participant">
                      <span
                        className={
                          'room-sidebar__participant-avatar' +
                          (participant.isSelf && isSpeaking ? ' room-sidebar__participant-avatar--speaking' : '')
                        }
                        style={{ background: getAvatarColor(participant.name) }}
                      >
                        {participant.name.charAt(0)}
                      </span>
                      <span className="room-sidebar__participant-name">{participant.name}</span>
                      {participant.isHost && <HostStarBadge className="room-sidebar__host-star" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {selectedRoom && (
        <VoiceConnectionStatus
          serverName={server.name}
          roomName={selectedRoom.name}
          latencyMs={latencyMs}
          onLeave={onLeave}
        />
      )}

      <UserPanel
        isMicMuted={isMicMuted}
        isDeafened={isDeafened}
        onToggleMic={onToggleMic}
        onToggleDeafen={onToggleDeafen}
        displayName={currentUser.displayName}
        avatarUrl={currentUser.avatarUrl}
        onOpenProfile={onOpenProfile}
      />
    </aside>
  );
}
