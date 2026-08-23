import { useEffect, useState } from 'react';
import type { RoomSummary, ServerSummary, UserProfile } from '@concord/shared';
import ServerRail from '../components/ServerRail';
import RoomSidebar from '../components/RoomSidebar';
import TopBar from '../components/TopBar';
import RoomView from '../components/RoomView';
import EmptyServerState from './EmptyServerState';
import ProfilePage from './ProfilePage';
import { getServer } from '../lib/api';
import { useRoomConnection } from '../hooks/useRoomConnection';
import '../styles/ServerListPage.css';

interface ServerListPageProps {
  currentUser: UserProfile;
  onCurrentUserChange: (user: UserProfile) => void;
  onActiveServerChange: (serverName: string) => void;
}

// No room-creation feature yet — the owned server always starts empty.
const rooms: RoomSummary[] = [];

export default function ServerListPage({
  currentUser,
  onCurrentUserChange,
  onActiveServerChange
}: ServerListPageProps) {
  const [ownedServer, setOwnedServer] = useState<ServerSummary | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  // Placeholder for the real signal: once WebRTC audio is wired, this will be
  // replaced by a getStats() poll reading each track's audioLevel (RFC 6464)
  // against a threshold, per the "Detecção de atividade de voz" stack decision.
  // Slowed down (~4s) so the effect is easy to observe during manual testing.
  const [isSpeaking, setIsSpeaking] = useState(false);
  // Same mock debt as isSpeaking above: real latency will come from the signaling
  // connection (RTT of the host-heartbeat round trip) once it exists. Cycles through
  // all three bands so the color-coding is visible without real network data.
  const [latencyMs, setLatencyMs] = useState(80);

  const {
    connectionStatus,
    selfPeerId,
    hostPeerId,
    peers,
    setLocalCameraTrack,
    setLocalScreenTrack
  } = useRoomConnection(selectedRoomId, currentUser.displayName, isMicMuted);

  useEffect(() => {
    if (!currentUser.ownedServerId) {
      setOwnedServer(null);
      return;
    }
    let cancelled = false;
    getServer(currentUser.ownedServerId).then((server) => {
      if (!cancelled) setOwnedServer(server);
    });
    return () => {
      cancelled = true;
    };
  }, [currentUser.ownedServerId]);

  useEffect(() => {
    onActiveServerChange(ownedServer?.name ?? 'Concord');
  }, [ownedServer, onActiveServerChange]);

  // Unexpected drop (not a manual "leave") — fall back to "Ninguém está em voz" instead of
  // showing a dead room view. No reconnect attempt in this pass, kept intentionally minimal.
  useEffect(() => {
    if (selectedRoomId && connectionStatus === 'disconnected') setSelectedRoomId(null);
  }, [connectionStatus, selectedRoomId]);

  useEffect(() => {
    if (!selectedRoomId) return;
    const interval = setInterval(() => setIsSpeaking((prev) => !prev), 4000);
    return () => clearInterval(interval);
  }, [selectedRoomId]);

  useEffect(() => {
    if (!selectedRoomId) return;
    const bandsMs = [80, 175, 230];
    let index = 0;
    const interval = setInterval(() => {
      index = (index + 1) % bandsMs.length;
      setLatencyMs(bandsMs[index]);
    }, 3000);
    return () => clearInterval(interval);
  }, [selectedRoomId]);

  function handleToggleMic() {
    setIsMicMuted((prev) => {
      const next = !prev;
      // Unmuting manually also lifts deafen — matches how Discord's headset behaves.
      if (!next && isDeafened) setIsDeafened(false);
      return next;
    });
  }

  function handleToggleDeafen() {
    setIsDeafened((prev) => {
      const next = !prev;
      // Deafening also mutes the mic; un-deafening does not auto-unmute.
      if (next) setIsMicMuted(true);
      return next;
    });
  }

  function handleLeave() {
    setSelectedRoomId(null);
  }

  if (!currentUser.ownedServerId) {
    return (
      <div className="server-list-page server-list-page--empty">
        <button
          className="server-list-page__profile-corner"
          onClick={() => setIsProfileOpen(true)}
          title="Seu perfil"
        >
          {currentUser.avatarUrl ? (
            <img src={currentUser.avatarUrl} alt="" />
          ) : (
            currentUser.displayName.charAt(0).toUpperCase()
          )}
        </button>

        <EmptyServerState
          currentUser={currentUser}
          onServerCreated={(server) => {
            setOwnedServer(server);
            onCurrentUserChange({ ...currentUser, ownedServerId: server.id });
          }}
        />

        {isProfileOpen && (
          <ProfilePage
            user={currentUser}
            onClose={() => setIsProfileOpen(false)}
            onUserChange={onCurrentUserChange}
          />
        )}
      </div>
    );
  }

  if (!ownedServer) {
    return <div className="server-list-page server-list-page--loading" />;
  }

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;

  return (
    <div className="server-list-page">
      <ServerRail servers={[ownedServer]} selectedServerId={ownedServer.id} onSelectServer={() => {}} />

      <RoomSidebar
        server={ownedServer}
        rooms={rooms}
        selectedRoomId={selectedRoomId}
        onSelectRoom={setSelectedRoomId}
        isMicMuted={isMicMuted}
        isDeafened={isDeafened}
        onToggleMic={handleToggleMic}
        onToggleDeafen={handleToggleDeafen}
        isSpeaking={isSpeaking && !isMicMuted}
        latencyMs={latencyMs}
        onLeave={handleLeave}
        selfPeerId={selfPeerId}
        hostPeerId={hostPeerId}
        peers={peers}
        currentUser={currentUser}
        onOpenProfile={() => setIsProfileOpen(true)}
      />

      <div className="server-list-page__main">
        <TopBar roomName={selectedRoom?.name ?? null} />
        <RoomView
          room={selectedRoom}
          isMicMuted={isMicMuted}
          onToggleMic={handleToggleMic}
          isSpeaking={isSpeaking}
          onLeave={handleLeave}
          isDeafened={isDeafened}
          selfPeerId={selfPeerId}
          hostPeerId={hostPeerId}
          peers={peers}
          setLocalCameraTrack={setLocalCameraTrack}
          setLocalScreenTrack={setLocalScreenTrack}
          currentUserDisplayName={currentUser.displayName}
        />
      </div>

      {isProfileOpen && (
        <ProfilePage
          user={currentUser}
          onClose={() => setIsProfileOpen(false)}
          onUserChange={onCurrentUserChange}
        />
      )}
    </div>
  );
}
