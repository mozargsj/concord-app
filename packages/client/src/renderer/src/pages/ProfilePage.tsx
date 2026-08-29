import { useState } from 'react';
import { Check, Flag, Loader2, LogOut, Pencil, X } from 'lucide-react';
import type { UserProfile } from '@concord/shared';
import ConfirmModal from '../components/ConfirmModal';
import ImageCropModal from '../components/ImageCropModal';
import ReportModal from '../components/ReportModal';
import Tooltip from '../components/Tooltip';
import { updateProfile } from '../lib/api';
import { pickImageFile, type PickedImageFile } from '../lib/imagePicker';
import { saveCachedImage } from '../lib/imageCache';
import '../styles/ProfilePage.css';

interface ProfilePageProps {
  user: UserProfile;
  /** Whatever server was selected when Profile was opened, if any — forwarded to ReportModal so
   * a bug/melhoria report keeps that context, purely optional (a report can be filed with none). */
  serverId?: string;
  onClose: () => void;
  onUserChange: (user: UserProfile) => void;
  onLogout: () => void;
}

export default function ProfilePage({ user, serverId, onClose, onUserChange, onLogout }: ProfilePageProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<PickedImageFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLogoutConfirmOpen, setIsLogoutConfirmOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);

  function handleStartEditName() {
    setDisplayName(user.displayName);
    setError(null);
    setIsEditingName(true);
  }

  function handleCancelEditName() {
    setDisplayName(user.displayName);
    setIsEditingName(false);
  }

  async function handleSaveName() {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed === user.displayName) {
      setIsEditingName(false);
      return;
    }
    setIsSavingName(true);
    setError(null);
    try {
      const updated = await updateProfile({ displayName: trimmed });
      // [Bug corrigido, 2026-08-29 — achado do Mozar] avatarUrl nunca vem de verdade do backend
      // (avatar é 100% P2P/cache local) — toUserProfile sempre devolve null pra esse campo agora.
      // Substituir `user` inteiro por `updated` aqui jogava fora o avatarUrl já hidratado
      // localmente toda vez que o nickname mudava — a foto sumia da sessão até reiniciar o app.
      // Só o displayName vem do servidor; o resto (avatarUrl incluso) continua o que já se sabia.
      onUserChange({ ...user, displayName: updated.displayName });
      setIsEditingName(false);
    } catch {
      setError('Não foi possível salvar o nome.');
    } finally {
      setIsSavingName(false);
    }
  }

  async function handleChangeAvatar() {
    setError(null);
    try {
      const picked = await pickImageFile();
      if (picked) setPendingCrop(picked);
    } catch {
      setError('Não foi possível ler a imagem.');
    }
  }

  // The image never leaves this machine — it's cached to disk under the user's own id and
  // shown immediately; other peers only ever see it by fetching it directly over the WebRTC
  // mesh while sharing a room with this user (useRoomConnection's image-request handling), so
  // there's no upload/URL round-trip to wait on here at all.
  async function handleApplyCrop(cropped: { data: ArrayBuffer; mimeType: string }) {
    setPendingCrop(null);
    setIsUploadingAvatar(true);
    setError(null);
    try {
      const { url } = await saveCachedImage('avatar', user.id, cropped.data, cropped.mimeType);
      onUserChange({ ...user, avatarUrl: url });
    } catch {
      setError('Não foi possível atualizar a foto.');
    } finally {
      setIsUploadingAvatar(false);
    }
  }

  return (
    <div className="profile-page__backdrop" onClick={onClose}>
      <div className="profile-page" onClick={(event) => event.stopPropagation()}>
        <header className="profile-page__header">
          <h2>Seu perfil</h2>
          <Tooltip label="Fechar">
            <button className="profile-page__close" onClick={onClose}>
              <X size={18} />
            </button>
          </Tooltip>
        </header>

        <button
          className="profile-page__avatar"
          onClick={handleChangeAvatar}
          disabled={isUploadingAvatar}
          title="Alterar foto"
        >
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="profile-page__avatar-image" />
          ) : (
            <span>{user.displayName.charAt(0).toUpperCase()}</span>
          )}
          <span
            className={'profile-page__avatar-overlay' + (isUploadingAvatar ? ' profile-page__avatar-overlay--visible' : '')}
          >
            {isUploadingAvatar ? <Loader2 size={20} className="profile-page__avatar-spinner" /> : 'Alterar'}
          </span>
        </button>

        <div className="profile-page__field">
          <span className="profile-page__label">Email</span>
          <p className="profile-page__value">{user.email}</p>
        </div>

        <div className="profile-page__field">
          <span className="profile-page__label">Nome de usuário</span>
          {isEditingName ? (
            <div className="profile-page__name-row">
              <input
                id="profile-display-name"
                className="profile-page__input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                disabled={isSavingName}
                autoFocus
              />
              <Tooltip label="Salvar">
                <button
                  className="profile-page__name-action"
                  onClick={handleSaveName}
                  disabled={isSavingName || !displayName.trim()}
                >
                  {isSavingName ? <Loader2 size={14} className="profile-page__name-action-spin" /> : <Check size={14} />}
                </button>
              </Tooltip>
              <Tooltip label="Cancelar">
                <button className="profile-page__name-action" onClick={handleCancelEditName} disabled={isSavingName}>
                  <X size={14} />
                </button>
              </Tooltip>
            </div>
          ) : (
            <div className="profile-page__name-row">
              <p className="profile-page__value profile-page__value--grow">{user.displayName}</p>
              <Tooltip label="Editar nome">
                <button className="profile-page__name-action" onClick={handleStartEditName}>
                  <Pencil size={14} />
                </button>
              </Tooltip>
            </div>
          )}
        </div>

        {error && <p className="profile-page__error">{error}</p>}

        <div className="profile-page__logout-section">
          <Tooltip label="Reportar um problema">
            <button className="profile-page__icon-action" onClick={() => setIsReportOpen(true)}>
              <Flag size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Sair da conta">
            <button
              className="profile-page__icon-action profile-page__icon-action--danger"
              onClick={() => setIsLogoutConfirmOpen(true)}
            >
              <LogOut size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      {pendingCrop && (
        <ImageCropModal
          data={pendingCrop.data}
          mimeType={pendingCrop.mimeType}
          onCancel={() => setPendingCrop(null)}
          onApply={handleApplyCrop}
        />
      )}

      {isReportOpen && <ReportModal serverId={serverId} onClose={() => setIsReportOpen(false)} />}

      {isLogoutConfirmOpen && (
        <ConfirmModal
          title="Sair da conta"
          message="Tem certeza que deseja sair? Isso encerra qualquer chamada em andamento e você vai precisar entrar de novo."
          confirmLabel="Sair"
          onCancel={() => setIsLogoutConfirmOpen(false)}
          onConfirm={onLogout}
        />
      )}
    </div>
  );
}
