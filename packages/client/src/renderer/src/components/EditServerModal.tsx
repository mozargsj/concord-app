import { useState } from 'react';
import type { ServerSummary } from '@concord/shared';
import { Check, Loader2, Pencil, Trash2, X } from 'lucide-react';
import ConfirmModal from './ConfirmModal';
import Tooltip from './Tooltip';
import ImageCropModal from './ImageCropModal';
import IllustratedNotice from './IllustratedNotice';
import uploadFailedArt from '../assets/images/upload-failed.png';
import { UPLOAD_FAILED_MESSAGES } from '../lib/errorMessages';
import { ApiError, deleteServer, updateServer } from '../lib/api';
import { pickImageFile, type PickedImageFile } from '../lib/imagePicker';
import { saveCachedImage } from '../lib/imageCache';
import '../styles/EditServerModal.css';

interface EditServerModalProps {
  server: ServerSummary;
  onClose: () => void;
  onServerUpdated: (server: ServerSummary) => void;
  onServerDeleted: (serverId: string) => void;
}

/**
 * Rename/re-icon an existing server — opened from ServerRail's right-click menu, owner only.
 * Name is persisted through a real PATCH; the icon stays local-cache + P2P only, same as the
 * rest of the avatar/icon system (decisions.md) — no backend round-trip for it.
 *
 * [2026-08-29, pedido do Mozar — mesmo fluxo do ProfilePage.tsx] Cada campo se aplica na hora,
 * sem um "Salvar" de rodapé pro modal inteiro: nome nasce como texto + ícone de editar; clicar
 * transforma em input + dois ícones novos (confirmar/cancelar). Ícone do servidor já aplicava na
 * hora antes (não precisou mudar). "Excluir servidor" também virou ícone+balão, mesma convenção.
 */
export default function EditServerModal({ server, onClose, onServerUpdated, onServerDeleted }: EditServerModalProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [name, setName] = useState(server.name);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingCropSource, setPendingCropSource] = useState<PickedImageFile | null>(null);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const [isUploadingIcon, setIsUploadingIcon] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUploadFailure, setIsUploadFailure] = useState(false);

  function handleStartEditName() {
    setName(server.name);
    setError(null);
    setIsEditingName(true);
  }

  function handleCancelEditName() {
    setName(server.name);
    setIsEditingName(false);
  }

  async function handleSaveName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === server.name) {
      setIsEditingName(false);
      return;
    }
    setIsSavingName(true);
    setError(null);
    setIsUploadFailure(false);
    try {
      const updated = await updateServer(server.id, trimmed);
      onServerUpdated(updated);
      setIsEditingName(false);
    } catch (err) {
      const isNameTaken = err instanceof ApiError && err.code === 'name-taken';
      setError(isNameTaken ? 'Esse nome já está em uso.' : 'Não foi possível salvar o nome.');
    } finally {
      setIsSavingName(false);
    }
  }

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

  async function handleApplyCrop(cropped: { data: ArrayBuffer; mimeType: string }) {
    setPendingCropSource(null);
    setIsUploadingIcon(true);
    setError(null);
    setIsUploadFailure(false);
    try {
      const { url } = await saveCachedImage('server-icon', server.id, cropped.data, cropped.mimeType);
      onServerUpdated({ ...server, iconUrl: url });
    } catch {
      setError('Não foi possível atualizar o ícone.');
      setIsUploadFailure(true);
    } finally {
      setIsUploadingIcon(false);
    }
  }

  async function handleConfirmDelete() {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteServer(server.id);
      onServerDeleted(server.id);
      onClose();
    } catch {
      setDeleteError('Não foi possível excluir o servidor.');
      setIsConfirmingDelete(false);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="edit-server-modal__backdrop" onClick={onClose}>
      <div className="edit-server-modal" onClick={(event) => event.stopPropagation()}>
        <header className="edit-server-modal__header">
          <h2>Editar servidor</h2>
          <Tooltip label="Fechar">
            <button className="edit-server-modal__close" onClick={onClose}>
              <X size={18} />
            </button>
          </Tooltip>
        </header>

        <button
          type="button"
          className="edit-server-modal__icon-picker"
          onClick={handlePickImage}
          disabled={isPickingImage || isUploadingIcon}
        >
          {server.iconUrl ? (
            <img src={server.iconUrl} alt="" className="edit-server-modal__icon-preview" />
          ) : (
            <span>{server.name.charAt(0).toUpperCase()}</span>
          )}
          <span
            className={
              'edit-server-modal__icon-overlay' + (isUploadingIcon ? ' edit-server-modal__icon-overlay--visible' : '')
            }
          >
            {isUploadingIcon ? <Loader2 size={20} className="edit-server-modal__icon-spin" /> : 'Alterar'}
          </span>
        </button>

        <div className="edit-server-modal__field">
          <span className="edit-server-modal__label">Nome do servidor</span>
          {isEditingName ? (
            <div className="edit-server-modal__name-row">
              <input
                id="edit-server-name"
                className="edit-server-modal__input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={isSavingName}
                autoFocus
              />
              <Tooltip label="Salvar">
                <button
                  className="edit-server-modal__name-action"
                  onClick={handleSaveName}
                  disabled={isSavingName || !name.trim()}
                >
                  {isSavingName ? <Loader2 size={14} className="edit-server-modal__icon-spin" /> : <Check size={14} />}
                </button>
              </Tooltip>
              <Tooltip label="Cancelar">
                <button className="edit-server-modal__name-action" onClick={handleCancelEditName} disabled={isSavingName}>
                  <X size={14} />
                </button>
              </Tooltip>
            </div>
          ) : (
            <div className="edit-server-modal__name-row">
              <p className="edit-server-modal__value">{server.name}</p>
              <Tooltip label="Editar nome">
                <button className="edit-server-modal__name-action" onClick={handleStartEditName}>
                  <Pencil size={14} />
                </button>
              </Tooltip>
            </div>
          )}
        </div>

        {error && isUploadFailure && (
          <IllustratedNotice icon={uploadFailedArt} messages={UPLOAD_FAILED_MESSAGES} detail={error} />
        )}
        {error && !isUploadFailure && <p className="edit-server-modal__error">{error}</p>}

        <div className="edit-server-modal__danger-zone">
          <Tooltip label="Excluir servidor">
            <button
              className="edit-server-modal__icon-action edit-server-modal__icon-action--danger"
              onClick={() => setIsConfirmingDelete(true)}
            >
              <Trash2 size={16} />
            </button>
          </Tooltip>
          {deleteError && <p className="edit-server-modal__error">{deleteError}</p>}
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

      {isConfirmingDelete && (
        <ConfirmModal
          title="Excluir servidor"
          message={`Excluir "${server.name}"? Todas as salas, cargos e convites desse servidor serão perdidos. Essa ação não pode ser desfeita.`}
          confirmLabel={isDeleting ? 'Excluindo…' : 'Excluir'}
          onCancel={() => setIsConfirmingDelete(false)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  );
}
