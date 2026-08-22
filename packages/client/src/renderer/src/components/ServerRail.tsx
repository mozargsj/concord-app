import type { MockServer } from '../fixtures/mockData';
import plusIcon from '../assets/icons/plus.svg';
import compassIcon from '../assets/icons/compass.svg';
import '../styles/ServerRail.css';

interface ServerRailProps {
  servers: MockServer[];
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
                {server.name.charAt(0).toUpperCase()}
                {!!server.unreadCount && (
                  <span className="server-rail__badge">{server.unreadCount}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      <button className="server-rail__item server-rail__item--add" title="Adicionar servidor">
        <img src={plusIcon} alt="" />
      </button>
      <button className="server-rail__item server-rail__item--explore" title="Explorar servidores">
        <img src={compassIcon} alt="" />
      </button>
    </nav>
  );
}
