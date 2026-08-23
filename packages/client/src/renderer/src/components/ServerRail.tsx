import type { ServerSummary } from '@concord/shared';
import plusIcon from '../assets/icons/plus.svg';
import compassIcon from '../assets/icons/compass.svg';
import '../styles/ServerRail.css';

interface ServerRailProps {
  servers: ServerSummary[];
  selectedServerId: string;
  onSelectServer: (serverId: string) => void;
}

export default function ServerRail({ servers, selectedServerId, onSelectServer }: ServerRailProps) {
  return (
    <nav className="server-rail">
      <button className="server-rail__item server-rail__item--home" title="Início">
        C
      </button>

      <div className="server-rail__divider" />

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

      {/* "1 dono : 1 servidor" já decidido — sem fluxo de entrar em servidor de terceiros ainda. */}
      <button
        className="server-rail__item server-rail__item--add"
        title="Você já tem um servidor"
        disabled
      >
        <img src={plusIcon} alt="" />
      </button>
      <button className="server-rail__item server-rail__item--explore" title="Explorar servidores" disabled>
        <img src={compassIcon} alt="" />
      </button>
    </nav>
  );
}
