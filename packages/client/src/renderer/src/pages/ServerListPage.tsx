import { useEffect, useState } from 'react';
import ServerRail from '../components/ServerRail';
import RoomSidebar from '../components/RoomSidebar';
import TopBar from '../components/TopBar';
import RoomView from '../components/RoomView';
import { mockRoomsByServer, mockServers } from '../fixtures/mockData';
import '../styles/ServerListPage.css';

interface ServerListPageProps {
  onActiveServerChange: (serverName: string) => void;
}

export default function ServerListPage({ onActiveServerChange }: ServerListPageProps) {
  const [selectedServerId, setSelectedServerId] = useState(mockServers[0].id);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  // Placeholder for the real signal: once WebRTC audio is wired, this will be
  // replaced by a getStats() poll reading each track's audioLevel (RFC 6464)
  // against a threshold, per the "Detecção de atividade de voz" stack decision.
  // Slowed down (~4s) so the effect is easy to observe during manual testing.
  const [isSpeaking, setIsSpeaking] = useState(false);
  // Same mock debt as isSpeaking above: real latency will come from the signaling
  // connection (RTT of the host-heartbeat round trip) once it exists. Cycles through
  // all three bands so the color-coding is visible without real network data.
  const [latencyMs, setLatencyMs] = useState(80);

  const selectedServer = mockServers.find((server) => server.id === selectedServerId)!;
  const rooms = mockRoomsByServer[selectedServerId] ?? [];
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;

  useEffect(() => {
    onActiveServerChange(selectedServer.name);
  }, [selectedServer, onActiveServerChange]);

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

  function handleSelectServer(serverId: string) {
    setSelectedServerId(serverId);
    setSelectedRoomId(null);
  }

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

  return (
    <div className="server-list-page">
      <ServerRail
        servers={mockServers}
        selectedServerId={selectedServerId}
        onSelectServer={handleSelectServer}
      />

      <RoomSidebar
        server={selectedServer}
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
      />

      <div className="server-list-page__main">
        <TopBar roomName={selectedRoom?.name ?? null} />
        <RoomView
          room={selectedRoom}
          isMicMuted={isMicMuted}
          onToggleMic={handleToggleMic}
          isSpeaking={isSpeaking}
          onLeave={handleLeave}
        />
      </div>
    </div>
  );
}
