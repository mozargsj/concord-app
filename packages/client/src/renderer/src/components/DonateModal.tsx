import donateQrCode from '../assets/images/donate-qrcode.png';
import '../styles/DonateModal.css';

interface DonateModalProps {
  onClose: () => void;
}

export default function DonateModal({ onClose }: DonateModalProps) {
  return (
    <div className="donate-modal__backdrop" onClick={onClose}>
      <div className="donate-modal" onClick={(event) => event.stopPropagation()}>
        <header className="donate-modal__header">
          <h2>Ajude esta iniciativa</h2>
          <button className="donate-modal__close" onClick={onClose} title="Fechar">
            ×
          </button>
        </header>

        <img src={donateQrCode} alt="QR Code Pix para doação" className="donate-modal__qrcode" />

        <p className="donate-modal__hint">Abra a câmera do celular e leia o QR Code para doar com Pix.</p>
      </div>
    </div>
  );
}
