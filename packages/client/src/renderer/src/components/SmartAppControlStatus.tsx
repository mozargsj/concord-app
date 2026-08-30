import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import NativeLoopbackHelpModal from './NativeLoopbackHelpModal';
import SmartAppControlIcon from './SmartAppControlIcon';
import Tooltip from './Tooltip';
import '../styles/SmartAppControlStatus.css';

/** Indicador visual de Smart App Control (pedido do Mozar, 2026-08-30) — escudo vermelho quando
 * ativo (pode estar bloqueando "Compartilhar áudio" e a correção de eco da transmissão de tela),
 * verde quando inativo. `null` (Windows sem SAC configurado ou plataforma != win32) já vem como
 * `false` de `smartAppControl.isActive()`, não há terceiro estado aqui de propósito — o indicador
 * é sempre um dos dois, sem "carregando" visível (a checagem é praticamente instantânea). */
export default function SmartAppControlStatus() {
  const [isActive, setIsActive] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.concord.smartAppControl.isActive().then((active) => {
      if (!cancelled) setIsActive(active);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="sac-status">
        <SmartAppControlIcon active={isActive} size={22} />
        <div className="sac-status__text">
          <span className="sac-status__label">Controle Inteligente de Aplicativos (Smart App Control)</span>
          <span className={'sac-status__value' + (isActive ? ' sac-status__value--active' : ' sac-status__value--inactive')}>
            {isActive ? 'Ativado' : 'Desativado'}
          </span>
        </div>
        <Tooltip label="Como desativar">
          <button type="button" className="sac-status__info" onClick={() => setIsHelpOpen(true)}>
            <Info size={16} />
          </button>
        </Tooltip>
      </div>
      {isActive && (
        <p className="sac-status__hint">
          Enquanto ativo, pode bloquear a correção de eco na transmissão de tela e o
          "Compartilhar áudio" de um app específico.
        </p>
      )}
      {isHelpOpen && <NativeLoopbackHelpModal onClose={() => setIsHelpOpen(false)} />}
    </>
  );
}
