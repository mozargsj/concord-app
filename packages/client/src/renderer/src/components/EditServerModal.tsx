import { useEffect, useState } from 'react';
import type { ServerSummary } from '@concord/shared';
import Button from './Button';
import ImageCropModal from './ImageCropModal';
import { ApiError, updateServer } from '../lib/api';
import { pickImageFile, type PickedImageFile } from '../lib/imagePicker';
import { saveCachedImage } from '../lib/imageCache';
import '../styles/EditServerModal.css';

interface EditServerModalProps {
  server: ServerSummary;
  onClose: () => void;
  onServerUpdated: (server: ServerSummary) => void;
}

/** Rename/re-icon an existing server — opened from ServerRail's right-click menu, owner only.
 * Name is persisted through a real PATCH (DynamoDB in production); the icon stays local-cache +
 * P2P only, same as the rest of the avatar/icon system (decisions.md) — no backend round-trip
 * for it, it's just re-cached under the same serverId key, overwriting what peers will fetch
 * next time they share a room with the owner. */
export default function EditServerModal({ server, onClose, onServerUpdated }: EditServerModalProps) {
  const [name, setName] = useState(server.name);
  // Separate from server.iconUrl on purpose: that blob URL is owned by imageCache.ts (other
  // parts of the UI — ServerRail, etc. — still render it), so it must never be revoked from in
  // here. Only a URL this component itself creates (via handleApplyCrop) gets cleaned up below.
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [pendingCropSource, setPendingCropSource] = useState<PickedImageFile | null>(null);
  const [pendingIcon, setPendingIcon] = useState<{ data: ArrayBuffer; mimeType: string } | null>(null);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    };
  }, [pendingPreviewUrl]);

  const previewUrl = pendingPreviewUrl ?? server.iconUrl;
  const trimmedName = name.trim();
  const hasChanges = pendingIcon !== null || (trimmedName !== '' && trimmedName !== server.name);

  async function handlePickImage() {
    setIsPickingImage(true);
    setError(null);
    try {
      const picked = await pickImageFile();
      if (picked) setPendingCropSource(picked);
    } catch {
      setError('Não foi possível ler a imagem.');
    } finally {
      setIsPickingImage(false);
    }
  }

  function handleApplyCrop(cropped: { data: ArrayBuffer; mimeType: string }) {
    setPendingCropSource(null);
    setPendingIcon(cropped);
    // The cleanup effect above (keyed on pendingPreviewUrl) revokes the previous one, if any.
    setPendingPreviewUrl(URL.createObjectURL(new Blob([cropped.data], { type: cropped.mimeType })));
  }

  async function handleSave() {
    if (!hasChanges) return;
    setIsSaving(true);
    setError(null);
    try {
      let updated: ServerSummary = server;
      if (trimmedName && trimmedName !== server.name) {
        updated = await updateServer(server.id, trimmedName);
      }
      if (pendingIcon) {
        const { url } = await saveCachedImage('server-icon', server.id, pendingIcon.data, pendingIcon.mimeType);
        updated = { ...updated, iconUrl: url };
      }
      onServerUpdated(updated);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'name-taken' ? 'Esse nome já está em uso.' : 'Não foi possível salvar as alterações.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="edit-server-modal__backdrop" onClick={onClose}>
      <div className="edit-server-modal" onClick={(event) => event.stopPropagation()}>
        <header className="edit-server-modal__header">
          <h2>Editar servidor</h2>
          <button className="edit-server-modal__close" onClick={onClose} title="Fechar">
            ×
          </button>
        </header>

        <button
          type="button"
          className="edit-server-modal__icon-picker"
          onClick={handlePickImage}
          disabled={isPickingImage}
        >
          {previewUrl ? (
            <img src={previewUrl} alt="" className="edit-server-modal__icon-preview" />
          ) : (
            <span>{server.name.charAt(0).toUpperCase()}</span>
          )}
          <span className="edit-server-modal__icon-overlay">{isPickingImage ? '…' : 'Alterar'}</span>
        </button>

        <div className="edit-server-modal__field">
          <label className="edit-server-modal__label" htmlFor="edit-server-name">
            Nome do servidor
          </label>
          <input
            id="edit-server-name"
            className="edit-server-modal__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </div>

        {error && <p className="edit-server-modal__error">{error}</p>}

        <div className="edit-server-modal__actions">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={!hasChanges || isSaving}>
            {isSaving ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      </div>

      {pendingCropSource && (
        <ImageCropModal
          data={pendingCropSource.data}
          mimeType={pendingCropSource.mimeType}
          onCancel={() => setPendingCropSource(null)}
          onApply={handleApplyCrop}
        />
      )}
    </div>
  );
}
