import { useState, type FormEvent } from 'react';
import type { ServerSummary, UserProfile } from '@concord/shared';
import Button from '../components/Button';
import { ApiError, createServer } from '../lib/api';
import { pickAndUploadImage } from '../lib/imageUpload';
import '../styles/EmptyServerState.css';

interface EmptyServerStateProps {
  currentUser: UserProfile;
  onServerCreated: (server: ServerSummary) => void;
}

export default function EmptyServerState({ currentUser, onServerCreated }: EmptyServerStateProps) {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [pendingIconKey, setPendingIconKey] = useState<string | null>(null);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePickImage() {
    setIsPickingImage(true);
    setError(null);
    try {
      const key = await pickAndUploadImage('server-icon', currentUser.id);
      if (key) setPendingIconKey(key);
    } catch {
      setError('Não foi possível enviar a imagem.');
    } finally {
      setIsPickingImage(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Digite um nome para o servidor.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const server = await createServer(trimmed, pendingIconKey ?? undefined);
      onServerCreated(server);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'name-taken') {
        setError('Esse nome já está em uso — escolha outro.');
      } else {
        setError('Não foi possível criar o servidor.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="empty-server-state">
      {!isFormOpen ? (
        <Button onClick={() => setIsFormOpen(true)}>Criar meu servidor</Button>
      ) : (
        <form className="empty-server-state__form" onSubmit={handleSubmit}>
          <h2 className="empty-server-state__title">Criar meu servidor</h2>

          <button
            type="button"
            className="empty-server-state__icon-picker"
            onClick={handlePickImage}
            disabled={isPickingImage}
          >
            {pendingIconKey
              ? 'Imagem selecionada ✓'
              : isPickingImage
                ? 'Enviando…'
                : 'Escolher imagem (opcional)'}
          </button>

          <input
            className="empty-server-state__input"
            placeholder="Nome do servidor"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />

          {error && <p className="empty-server-state__error">{error}</p>}

          <div className="empty-server-state__actions">
            <Button
              variant="ghost"
              type="button"
              onClick={() => setIsFormOpen(false)}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Criando…' : 'Criar servidor'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
