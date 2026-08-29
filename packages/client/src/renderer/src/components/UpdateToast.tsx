import { Download, X } from 'lucide-react';
import Button from './Button';
import '../styles/UpdateToast.css';

interface UpdateToastProps {
  version: string;
  onUpdate: () => void;
  onDismiss: () => void;
}

/**
 * One-time balloon shown the moment the server pushes an update-available notification (see
 * App.tsx/lib/updateNotifications.ts) — dismissing it just hides the balloon, TitleBar.tsx's icon
 * stays up so the update is still reachable later. Neither this nor the icon installs anything by
 * themselves — "Atualizar agora" opens the same confirm step App.tsx already has for the icon.
 */
export default function UpdateToast({ version, onUpdate, onDismiss }: UpdateToastProps) {
  return (
    <div className="update-toast" role="status">
      <Download size={18} className="update-toast__icon" />
      <div className="update-toast__body">
        <p className="update-toast__title">Nova versão do Concord disponível</p>
        <p className="update-toast__hint">Versão {version} já pode ser instalada.</p>
        <div className="update-toast__actions">
          <Button variant="primary" onClick={onUpdate}>
            Atualizar agora
          </Button>
          <Button variant="ghost" onClick={onDismiss}>
            Depois
          </Button>
        </div>
      </div>
      <button className="update-toast__close" title="Dispensar" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  );
}
