import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { ServerSummary, UserProfile } from '@concord/shared';
import { Plus, UserPlus, Compass } from 'lucide-react';
import ContextMenu from './ContextMenu';
import EditServerModal from './EditServerModal';
import '../styles/ServerRail.css';

interface ServerRailProps {
  currentUser: UserProfile;
  hasOwnServer: boolean;
  servers: ServerSummary[];
  selectedServerId: string | null;
  onSelectServer: (serverId: string) => void;
  onOpenProfile: () => void;
  onOpenInvite: () => void;
  onOpenCreateServer: () => void;
  onServerUpdated: (server: ServerSummary) => void;
  onServerDeleted: (serverId: string) => void;
}

interface ServerContextMenuState {
  server: ServerSummary;
  x: number;
  y: number;
}

export default function ServerRail({
  currentUser,
  hasOwnServer,
  servers,
  selectedServerId,
  onSelectServer,
  onOpenProfile,
  onOpenInvite,
  onOpenCreateServer,
  onServerUpdated,
  onServerDeleted
}: ServerRailProps) {
  const [contextMenu, setContextMenu] = useState<ServerContextMenuState | null>(null);
  // Holds only the id being edited — the object itself is looked up fresh from `servers` below on
  // every render, instead of a snapshot frozen at the moment the context menu was clicked. A
  // frozen snapshot never saw EditServerModal's own onServerUpdated calls (icon/name changes bubble
  // up to ServerListPage and back down through the `servers` prop, not back into this component's
  // own state), so the modal's own preview — and this rail's icon, until next reload — never
  // reflected a change the owner had just made. [Bug real, achado pelo Mozar em teste, 2026-08-30]
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const editingServer = editingServerId ? (servers.find((server) => server.id === editingServerId) ?? null) : null;

  function handleServerContextMenu(event: ReactMouseEvent, server: ServerSummary) {
    event.preventDefault();
    // Only the owner can rename/re-icon — right-click does nothing for anyone else's server.
    if (server.ownerUserId !== currentUser.id) return;
    setContextMenu({ server, x: event.clientX, y: event.clientY });
  }

  return (
    <nav className="server-rail">
      <button className="server-rail__item server-rail__item--profile" onClick={onOpenProfile} title="Seu perfil">
        {currentUser.avatarUrl ? (
          <img src={currentUser.avatarUrl} alt="" className="server-rail__item-icon" />
        ) : (
          currentUser.displayName.charAt(0).toUpperCase()
        )}
      </button>

      <button className="server-rail__item server-rail__item--invite" onClick={onOpenInvite} title="Entrar com convite">
        <UserPlus size={20} />
      </button>

      {!hasOwnServer && (
        <button className="server-rail__item server-rail__item--add" onClick={onOpenCreateServer} title="Criar servidor">
          <Plus size={20} />
        </button>
      )}

      {servers.length > 0 && <div className="server-rail__divider" />}

      <div className="server-rail__list">
        {servers.map((server) => {
          const isActive = server.id === selectedServerId;
          return (
            <div key={server.id} className="server-rail__entry">
              <span className={'server-rail__indicator' + (isActive ? ' server-rail__indicator--visible' : '')} />
              <button
                className={'server-rail__item' + (isActive ? ' server-rail__item--active' : '')}
                onClick={() => onSelectServer(server.id)}
                onContextMenu={(event) => handleServerContextMenu(event, server)}
                title={server.name}
              >
                {server.iconUrl ? (
                  <img src={server.iconUrl} alt="" className="server-rail__item-icon" />
                ) : (
                  server.name.charAt(0).toUpperCase()
                )}
              </button>
            </div>
          );
        })}
      </div>

      <button className="server-rail__item server-rail__item--explore" title="Explorar servidores" disabled>
        <Compass size={20} />
      </button>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: 'Editar servidor',
              onSelect: () => setEditingServerId(contextMenu.server.id)
            }
          ]}
        />
      )}

      {editingServer && (
        <EditServerModal
          server={editingServer}
          onClose={() => setEditingServerId(null)}
          onServerUpdated={onServerUpdated}
          onServerDeleted={onServerDeleted}
        />
      )}
    </nav>
  );
}
