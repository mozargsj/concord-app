import { useEffect, useState, type FormEvent } from 'react';
import type { ServerSummary } from '@concord/shared';
import Button from './Button';
import ImageCropModal from './ImageCropModal';
import IllustratedNotice from './IllustratedNotice';
import uploadFailedArt from '../assets/images/upload-failed.png';
import { UPLOAD_FAILED_MESSAGES } from '../lib/errorMessages';
import { ApiError, createServer, joinServerWithCode } from '../lib/api';
import { pickImageFile, type PickedImageFile } from '../lib/imagePicker';
import { saveCachedImage } from '../lib/imageCache';
import '../styles/ServerActionsModal.css';

interface ServerActionsModalProps {
  mode: 'create' | 'join';
  onClose: () => void;
  onServerCreated: (server: ServerSummary) => void;
  onServerJoined: (server: ServerSummary) => void;
}

export default function ServerActionsModal({ mode, onClose, onServerCreated, onServerJoined }: ServerActionsModalProps) {
  const [name, setName] = useState('');
  const [pendingCropSource, setPendingCropSource] = useState<PickedImageFile | null>(null);
  const [pendingIcon, setPendingIcon] = useState<PickedImageFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreateFailure, setIsCreateFailure] = useState(false);

  const [code, setCode] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Revokes the previous object URL whenever a new one is picked, and on unmount.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function handlePickImage() {
    setIsPickingImage(true);
    setCreateError(null);
    setIsCreateFailure(false);
    try {
      const picked = await pickImageFile();
      if (picked) setPendingCropSource(picked);
    } catch {
      setCreateError('Não foi possível ler a imagem.');
    } finally {
      setIsPickingImage(false);
    }
  }

  // No serverId exists yet at pick time, so this only builds a preview + holds the cropped
  // bytes — the actual disk cache write (keyed by the real serverId) happens in handleCreate,
  // once creation succeeds and that id exists (see imageCache.ts's saveCachedImage).
  function handleApplyCrop(cropped: { data: ArrayBuffer; mimeType: string }) {
    setPendingCropSource(null);
    setPendingIcon(cropped);
    // The cleanup effect below (keyed on previewUrl) revokes the previous object URL, if any.
    setPreviewUrl(URL.createObjectURL(new Blob([cropped.data], { type: cropped.mimeType })));
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setCreateError('Digite um nome para o servidor.');
      setIsCreateFailure(false);
      return;
    }
    setIsCreating(true);
    setCreateError(null);
    setIsCreateFailure(false);
    try {
      const server = await createServer(trimmed);
      if (pendingIcon) {
        const { url } = await saveCachedImage('server-icon', server.id, pendingIcon.data, pendingIcon.mimeType);
        onServerCreated({ ...server, iconUrl: url });
      } else {
        onServerCreated(server);
      }
    } catch (err) {
      const isNameTaken = err instanceof ApiError && err.code === 'name-taken';
      setCreateError(isNameTaken ? 'Esse nome já está em uso.' : 'Não foi possível criar o servidor.');
      setIsCreateFailure(!isNameTaken);
    } finally {
      setIsCreating(false);
    }
  }

  async function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setJoinError('Cole um código de convite.');
      return;
    }
    setIsJoining(true);
    setJoinError(null);
    try {
      const server = await joinServerWithCode(trimmed);
      onServerJoined(server);
    } catch {
      setJoinError('Convite inválido ou expirado.');
    } finally {
      setIsJoining(false);
    }
  }

  return (
    <div className="server-actions-modal__backdrop" onClick={onClose}>
      <div className="server-actions-modal" onClick={(event) => event.stopPropagation()}>
        <header className="server-actions-modal__header">
          <h2>{mode === 'create' ? 'Criar meu servidor' : 'Entrar com convite'}</h2>
          <button className="server-actions-modal__close" onClick={onClose} title="Fechar">
            ×
          </button>
        </header>

        {mode === 'create' ? (
          <form className="server-actions-modal__section" onSubmit={handleCreate}>
            <button
              type="button"
              className={
                'server-actions-modal__icon-picker' + (previewUrl ? ' server-actions-modal__icon-picker--filled' : '')
              }
              onClick={handlePickImage}
              disabled={isPickingImage}
            >
              {previewUrl ? (
                <img src={previewUrl} alt="" className="server-actions-modal__icon-preview" />
              ) : isPickingImage ? (
                'Lendo…'
              ) : (
                'Escolher imagem (opcional)'
              )}
            </button>
            <input
              className="server-actions-modal__input"
              placeholder="Nome do servidor"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            {createError && isCreateFailure && (
              <IllustratedNotice icon={uploadFailedArt} messages={UPLOAD_FAILED_MESSAGES} detail={createError} />
            )}
            {createError && !isCreateFailure && <p className="server-actions-modal__error">{createError}</p>}
            <Button type="submit" disabled={isCreating}>
              {isCreating ? 'Criando…' : 'Criar servidor'}
            </Button>
          </form>
        ) : (
          <form className="server-actions-modal__section" onSubmit={handleJoin}>
            <input
              className="server-actions-modal__input"
              placeholder="Cole o código do convite"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoFocus
            />
            {joinError && <p className="server-actions-modal__error">{joinError}</p>}
            <Button type="submit" disabled={isJoining}>
              {isJoining ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>
        )}
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
