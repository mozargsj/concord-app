import Button from './Button';
import '../styles/ConfirmModal.css';

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancelar',
  onCancel,
  onConfirm
}: ConfirmModalProps) {
  return (
    <div className="confirm-modal__backdrop" onClick={onCancel}>
      <div className="confirm-modal" onClick={(event) => event.stopPropagation()}>
        <header className="confirm-modal__header">
          <h2>{title}</h2>
        </header>

        <p className="confirm-modal__message">{message}</p>

        <div className="confirm-modal__actions">
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
