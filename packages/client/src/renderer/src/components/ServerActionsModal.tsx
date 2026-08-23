import { useEffect, useState, type FormEvent } from 'react';
import type { ServerSummary, UserProfile } from '@concord/shared';
import Button from './Button';
import { ApiError, createServer, joinServerWithCode } from '../lib/api';
import { pickAndUploadImage } from '../lib/imageUpload';
import '../styles/ServerActionsModal.css';

interface ServerActionsModalProps {
  currentUser: UserProfile;
  mode: 'create' | 'join';
  onClose: () => void;
  onServerCreated: (server: ServerSummary) => void;
  onServerJoined: (server: ServerSummary) => void;
}

export default function ServerActionsModal({
  currentUser,
  mode,
  onClose,
  onServerCreated,
  onServerJoined
}: ServerActionsModalProps) {
  const [name, setName] = useState('');
  const [pendingIconKey, setPendingIconKey] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
    try {
      const key = await pickAndUploadImage('server-icon', currentUser.id, setPreviewUrl);
      if (key) setPendingIconKey(key);
    } catch {
      setCreateError('Não foi possível enviar a imagem.');
    } finally {
      setIsPickingImage(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setCreateError('Digite um nome para o servidor.');
      return;
    }
    setIsCreating(true);
    setCreateError(null);
    try {
      const server = await createServer(trimmed, pendingIconKey ?? undefined);
      onServerCreated(server);
    } catch (err) {
      setCreateError(err instanceof ApiError && err.code === 'name-taken' ? 'Esse nome já está em uso.' : 'Não foi possível criar o servidor.');
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
                'Enviando…'
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
            {createError && <p className="server-actions-modal__error">{createError}</p>}
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
    </div>
  );
}
