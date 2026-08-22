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

  const selectedServer = mockServers.find((server) => server.id === selectedServerId)!;
  const rooms = mockRoomsByServer[selectedServerId] ?? [];
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;

  useEffect(() => {
    onActiveServerChange(selectedServer.name);
  }, [selectedServer, onActiveServerChange]);

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
      />

      <div className="server-list-page__main">
        <TopBar roomName={selectedRoom?.name ?? null} />
        <RoomView
          room={selectedRoom}
          isMicMuted={isMicMuted}
          onToggleMic={handleToggleMic}
          onLeave={() => setSelectedRoomId(null)}
        />
      </div>
    </div>
  );
}
