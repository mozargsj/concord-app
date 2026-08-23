import { useState, type KeyboardEvent } from 'react';
import type { RoomSummary, ServerSummary, UserProfile } from '@concord/shared';
import UserPanel from './UserPanel';
import VoiceConnectionStatus from './VoiceConnectionStatus';
import HostStarBadge from './HostStarBadge';
import LiveBadge from './LiveBadge';
import ConfirmModal from './ConfirmModal';
import { ChevronDown, UserPlus, Plus, Volume2, Video, VideoOff, ScreenShare, LayoutGrid, Megaphone } from 'lucide-react';
import { getAvatarColor } from '../lib/avatarColor';
import type { RoomPeer } from '../hooks/useRoomConnection';
import '../styles/RoomSidebar.css';

const ROLE_DONO = 1;
const ROLE_ADMIN = 2;

interface RoomSidebarProps {
  server: ServerSummary;
  myRole: number;
  rooms: RoomSummary[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onCreateRoom: (name: string) => void;
  onRenameRoom: (roomId: string, name: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onOpenInvite: () => void;
  isMicMuted: boolean;
  isDeafened: boolean;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  onSelectMic: (deviceId: string) => void;
  onSelectSpeaker: (deviceId: string) => void;
  isSpeaking: boolean;
  latencyMs: number | null;
  onLeave: () => void;
  selfPeerId: string | null;
  hostPeerId: string | null;
  peers: RoomPeer[];
  currentUser: UserProfile;
  onOpenProfile: () => void;
  selfCameraOn: boolean;
  selfSharingScreen: boolean;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
}

export default function RoomSidebar({
  server,
  myRole,
  rooms,
  selectedRoomId,
  onSelectRoom,
  onCreateRoom,
  onRenameRoom,
  onDeleteRoom,
  onOpenInvite,
  isMicMuted,
  isDeafened,
  onToggleMic,
  onToggleDeafen,
  onSelectMic,
  onSelectSpeaker,
  isSpeaking,
  latencyMs,
  onLeave,
  selfPeerId,
  hostPeerId,
  peers,
  currentUser,
  onOpenProfile,
  selfCameraOn,
  selfSharingScreen,
  onToggleCamera,
  onToggleScreenShare
}: RoomSidebarProps) {
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [roomPendingDelete, setRoomPendingDelete] = useState<RoomSummary | null>(null);

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;
  const canCreateOrDeleteRooms = myRole <= ROLE_DONO;
  const canRenameRooms = myRole <= ROLE_ADMIN;
  const canInvite = myRole <= ROLE_ADMIN;

  function submitCreateRoom() {
    const trimmed = newRoomName.trim();
    if (trimmed) onCreateRoom(trimmed);
    setNewRoomName('');
    setIsCreatingRoom(false);
  }

  function handleCreateKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') submitCreateRoom();
    if (event.key === 'Escape') {
      setNewRoomName('');
      setIsCreatingRoom(false);
    }
  }

  function startRenaming(room: RoomSummary) {
    setEditingRoomId(room.id);
    setEditingName(room.name);
  }

  function submitRename(roomId: string) {
    const trimmed = editingName.trim();
    if (trimmed) onRenameRoom(roomId, trimmed);
    setEditingRoomId(null);
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>, roomId: string) {
    if (event.key === 'Enter') submitRename(roomId);
    if (event.key === 'Escape') setEditingRoomId(null);
  }

  function confirmDeleteRoom() {
    if (roomPendingDelete) onDeleteRoom(roomPendingDelete.id);
    setRoomPendingDelete(null);
  }

  return (
    <aside className="room-sidebar">
      <header className="room-sidebar__header">
        <span className="room-sidebar__server-name">{server.name}</span>
        <div className="room-sidebar__header-actions">
          {canInvite && (
            <button className="room-sidebar__icon-button" title="Convidar pessoas" onClick={onOpenInvite}>
              <UserPlus size={24} />
            </button>
          )}
          <ChevronDown size={24} className="room-sidebar__chevron" />
        </div>
      </header>

      <div className="room-sidebar__rooms">
        <div className="room-sidebar__category">
          <div className="room-sidebar__category-label">
            <ChevronDown size={18} className="room-sidebar__category-chevron" />
            <span>Canais de Voz</span>
          </div>
          {canCreateOrDeleteRooms && (
            <button
              className="room-sidebar__icon-button"
              title="Criar sala"
              onClick={() => setIsCreatingRoom((prev) => !prev)}
            >
              <Plus size={24} />
            </button>
          )}
        </div>

        {isCreatingRoom && (
          <input
            className="room-sidebar__room-input"
            autoFocus
            placeholder="Nome da sala"
            value={newRoomName}
            onChange={(event) => setNewRoomName(event.target.value)}
            onKeyDown={handleCreateKeyDown}
            onBlur={submitCreateRoom}
          />
        )}

        {rooms.map((room) => {
          const isJoined = room.id === selectedRoomId;
          // Real roster for the joined room, driven by signaling. Rooms the user hasn't
          // joined have no presence protocol yet (server only tracks membership for the
          // connected socket's own room), so they show no participant preview.
          const participants: {
            key: string;
            name: string;
            isSelf: boolean;
            isHost: boolean;
            isSpeaking: boolean;
            isBroadcasting: boolean;
          }[] = isJoined
            ? [
                {
                  key: 'self',
                  name: currentUser.displayName,
                  isSelf: true,
                  isHost: selfPeerId !== null && selfPeerId === hostPeerId,
                  isSpeaking,
                  isBroadcasting: selfCameraOn || selfSharingScreen
                },
                ...peers.map((peer) => ({
                  key: peer.peerId,
                  name: peer.displayName,
                  isSelf: false,
                  isHost: peer.peerId === hostPeerId,
                  isSpeaking: peer.isSpeaking,
                  isBroadcasting:
                    (!!peer.personalStream && peer.personalStream.getVideoTracks().length > 0) ||
                    !!peer.screenStream
                }))
              ]
            : [];

          const isEditing = editingRoomId === room.id;

          return (
            <div key={room.id} className="room-sidebar__room-block">
              {isEditing ? (
                <input
                  className="room-sidebar__room-input"
                  autoFocus
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  onKeyDown={(event) => handleRenameKeyDown(event, room.id)}
                  onBlur={() => submitRename(room.id)}
                />
              ) : (
                <div className="room-sidebar__room-row">
                  <button
                    className={'room-sidebar__room' + (isJoined ? ' room-sidebar__room--active' : '')}
                    onClick={() => onSelectRoom(room.id)}
                  >
                    <Volume2 size={16} className="room-sidebar__room-icon" />
                    <span className="room-sidebar__room-name">{room.name}</span>
                    <span className="room-sidebar__room-count">
                      {room.memberCount}/{room.maxMembers}
                    </span>
                  </button>
                  {(canRenameRooms || canCreateOrDeleteRooms) && (
                    <div className="room-sidebar__room-actions">
                      {canRenameRooms && (
                        <button
                          className="room-sidebar__room-action"
                          title="Renomear sala"
                          onClick={() => startRenaming(room)}
                        >
                          Renomear
                        </button>
                      )}
                      {canCreateOrDeleteRooms && (
                        <button
                          className="room-sidebar__room-action"
                          title="Excluir sala"
                          onClick={() => setRoomPendingDelete(room)}
                        >
                          Excluir
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {participants.length > 0 && (
                <div className="room-sidebar__participants">
                  {participants.map((participant) => (
                    <div key={participant.key} className="room-sidebar__participant">
                      <span
                        className={
                          'room-sidebar__participant-avatar' +
                          (participant.isSpeaking ? ' room-sidebar__participant-avatar--speaking' : '')
                        }
                        style={{ background: getAvatarColor(participant.name) }}
                      >
                        {participant.name.charAt(0)}
                      </span>
                      <span className="room-sidebar__participant-name">{participant.name}</span>
                      {participant.isBroadcasting && <LiveBadge className="room-sidebar__live-badge" />}
                      {participant.isHost && <HostStarBadge className="room-sidebar__host-star" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="room-sidebar__overlay">
        <div className="room-sidebar__panel">
          {selectedRoom && (
            <VoiceConnectionStatus
              serverName={server.name}
              roomName={selectedRoom.name}
              latencyMs={latencyMs ?? 0}
              onLeave={onLeave}
            />
          )}

          {selectedRoom && (
            <div className="room-sidebar__quick-actions">
              <button
                className={
                  'room-sidebar__quick-action' + (selfCameraOn ? '' : ' room-sidebar__quick-action--off')
                }
                title={selfCameraOn ? 'Desligar câmera' : 'Ligar câmera'}
                onClick={onToggleCamera}
              >
                {selfCameraOn ? <Video size={18} /> : <VideoOff size={18} />}
              </button>
              <button
                className={
                  'room-sidebar__quick-action' + (selfSharingScreen ? ' room-sidebar__quick-action--active' : '')
                }
                title={selfSharingScreen ? 'Parar transmissão' : 'Transmitir tela'}
                onClick={onToggleScreenShare}
              >
                <ScreenShare size={18} />
              </button>
              <button className="room-sidebar__quick-action" title="Em breve" disabled>
                <LayoutGrid size={18} />
              </button>
              <button className="room-sidebar__quick-action" title="Em breve" disabled>
                <Megaphone size={18} />
              </button>
            </div>
          )}

          <UserPanel
            isMicMuted={isMicMuted}
            isDeafened={isDeafened}
            onToggleMic={onToggleMic}
            onToggleDeafen={onToggleDeafen}
            onSelectMic={onSelectMic}
            onSelectSpeaker={onSelectSpeaker}
            displayName={currentUser.displayName}
            avatarUrl={currentUser.avatarUrl}
            onOpenProfile={onOpenProfile}
          />
        </div>
      </div>

      {roomPendingDelete && (
        <ConfirmModal
          title="Excluir sala"
          message={`Excluir a sala "${roomPendingDelete.name}"? Essa ação não pode ser desfeita.`}
          confirmLabel="Excluir"
          onCancel={() => setRoomPendingDelete(null)}
          onConfirm={confirmDeleteRoom}
        />
      )}
    </aside>
  );
}
