import type { ServerSummary, UserProfile } from '@concord/shared';
import { Plus, UserPlus, Compass } from 'lucide-react';
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
}

export default function ServerRail({
  currentUser,
  hasOwnServer,
  servers,
  selectedServerId,
  onSelectServer,
  onOpenProfile,
  onOpenInvite,
  onOpenCreateServer
}: ServerRailProps) {
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
    </nav>
  );
}
