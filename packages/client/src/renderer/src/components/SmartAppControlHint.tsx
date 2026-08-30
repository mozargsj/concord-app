import { useState } from 'react';
import { Info } from 'lucide-react';
import NativeLoopbackHelpModal from './NativeLoopbackHelpModal';
import Tooltip from './Tooltip';
import '../styles/SmartAppControlHint.css';

interface SmartAppControlHintProps {
  /** Texto breve — o motivo específico do recurso que chamou este hint (eco na transmissão de
   * tela, ou o próprio "Compartilhar áudio" indisponível). O passo a passo genérico fica todo no
   * modal, não repetido aqui. */
  text: string;
}

/** Texto breve + ícone de informação, usado nos dois recursos que dependem do addon nativo
 * bloqueável pelo Smart App Control (ScreenSharePicker e AudioSharePicker) — clique no ícone abre
 * o passo a passo de como desativar (NativeLoopbackHelpModal). */
export default function SmartAppControlHint({ text }: SmartAppControlHintProps) {
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  return (
    <>
      <div className="sac-hint">
        <span className="sac-hint__text">{text}</span>
        <Tooltip label="Como ativar">
          <button type="button" className="sac-hint__info" onClick={() => setIsHelpOpen(true)}>
            <Info size={14} />
          </button>
        </Tooltip>
      </div>
      {isHelpOpen && <NativeLoopbackHelpModal onClose={() => setIsHelpOpen(false)} />}
    </>
  );
}
