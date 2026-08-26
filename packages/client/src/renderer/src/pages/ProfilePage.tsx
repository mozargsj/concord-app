import { useState } from 'react';
import type { UserProfile } from '@concord/shared';
import Button from '../components/Button';
import ConfirmModal from '../components/ConfirmModal';
import ImageCropModal from '../components/ImageCropModal';
import ReportModal from '../components/ReportModal';
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
  const [displayName, setDisplayName] = useState(user.displayName);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<PickedImageFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLogoutConfirmOpen, setIsLogoutConfirmOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);

  async function handleSaveName() {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed === user.displayName) return;
    setIsSavingName(true);
    setError(null);
    try {
      const updated = await updateProfile({ displayName: trimmed });
      onUserChange(updated);
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
          <button className="profile-page__close" onClick={onClose} title="Fechar">
            ×
          </button>
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
            <span>{displayName.charAt(0).toUpperCase()}</span>
          )}
          <span className="profile-page__avatar-overlay">{isUploadingAvatar ? '…' : 'Alterar'}</span>
        </button>

        <div className="profile-page__field">
          <span className="profile-page__label">Email</span>
          <p className="profile-page__value">{user.email}</p>
        </div>

        <div className="profile-page__field">
          <label className="profile-page__label" htmlFor="profile-display-name">
            Nome de usuário
          </label>
          <div className="profile-page__name-row">
            <input
              id="profile-display-name"
              className="profile-page__input"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <Button
              variant="ghost"
              onClick={handleSaveName}
              disabled={isSavingName || !displayName.trim() || displayName.trim() === user.displayName}
            >
              {isSavingName ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
        </div>

        {error && <p className="profile-page__error">{error}</p>}

        <div className="profile-page__logout-section">
          <Button variant="ghost" onClick={() => setIsReportOpen(true)}>
            Reportar um problema
          </Button>
          <Button
            variant="danger"
            className="profile-page__logout"
            onClick={() => setIsLogoutConfirmOpen(true)}
          >
            Sair da conta
          </Button>
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
