import { useState } from 'react';
import type { ReportType } from '@concord/shared';
import Button from './Button';
import IllustratedNotice from './IllustratedNotice';
import supportArt from '../assets/images/support.png';
import uploadFailedArt from '../assets/images/upload-failed.png';
import { createReport } from '../lib/api';
import { UPLOAD_FAILED_MESSAGES } from '../lib/errorMessages';
import '../styles/ReportModal.css';

interface ReportModalProps {
  serverId?: string;
  onClose: () => void;
}

/** "Reportar um problema" — decisions.md §7's `reports` table finally gets a UI/route in front of
 * it (until now: automatic error capture only, no way for a person to just tell us something).
 * Opened from ProfilePage; serverId is whatever the user had selected, if any — optional, a
 * report can be filed with no server context. */
export default function ReportModal({ serverId, onClose }: ReportModalProps) {
  const [type, setType] = useState<ReportType>('bug');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    const trimmed = message.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await createReport(type, trimmed, serverId);
      setIsSent(true);
    } catch {
      setError('Não foi possível enviar o report.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="report-modal__backdrop" onClick={onClose}>
      <div className="report-modal" onClick={(event) => event.stopPropagation()}>
        <header className="report-modal__header">
          <h2>Reportar um problema</h2>
          <button className="report-modal__close" onClick={onClose} title="Fechar">
            ×
          </button>
        </header>

        {isSent ? (
          <div className="report-modal__sent">
            <img src={supportArt} alt="" className="report-modal__sent-icon" />
            <p className="report-modal__sent-message">
              Recebemos seu report! O time (e o gato de plantão) já está de olho nisso.
            </p>
            <Button onClick={onClose}>Fechar</Button>
          </div>
        ) : (
          <>
            <div className="report-modal__type">
              <button
                type="button"
                className={'report-modal__type-option' + (type === 'bug' ? ' report-modal__type-option--active' : '')}
                onClick={() => setType('bug')}
              >
                Bug
              </button>
              <button
                type="button"
                className={
                  'report-modal__type-option' + (type === 'suggestion' ? ' report-modal__type-option--active' : '')
                }
                onClick={() => setType('suggestion')}
              >
                Sugestão
              </button>
            </div>

            <textarea
              className="report-modal__textarea"
              placeholder={
                type === 'bug' ? 'O que deu errado? Quanto mais detalhe, melhor.' : 'O que você gostaria de ver no Concord?'
              }
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={5}
              autoFocus
            />

            {error && <IllustratedNotice icon={uploadFailedArt} messages={UPLOAD_FAILED_MESSAGES} detail={error} />}

            <div className="report-modal__actions">
              <Button variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button onClick={handleSubmit} disabled={!message.trim() || isSubmitting}>
                {isSubmitting ? 'Enviando…' : 'Enviar'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
