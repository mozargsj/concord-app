import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import '../styles/Tooltip.css';

interface TooltipProps {
  label: string;
  children: ReactNode;
  /** Which side of the trigger the balloon opens on — 'top' fits most toolbar/icon-row contexts
   * (balloon has room above, tail points down at the icon); pick 'bottom'/'left'/'right' for
   * triggers near an edge where 'top' would clip. */
  side?: 'top' | 'bottom' | 'left' | 'right';
}

interface BalloonPosition {
  left: number;
  top: number;
  transform: string;
}

const GAP_PX = 9;

/** [2026-08-30, pedido do Mozar] Mesma ideia de sempre (posição relativa ao trigger, via CSS), só
 * que agora em coordenadas de viewport (`position: fixed`) em vez de relativas ao wrapper — o
 * balão em si é portado pro final do `document.body` (ver o `return` abaixo). Achado real: um
 * trigger dentro de um ancestral com overflow (`.room-sidebar__rooms`, `overflow-y: auto`) cortava
 * o balão pela metade, porque `position: absolute` puro fica preso ao clipping do ancestral mais
 * próximo — o próprio comentário antigo deste arquivo já avisava desse limite, só nunca tinha sido
 * batido antes de existir um trigger dentro de uma lista rolável. */
function computeBalloonPosition(triggerRect: DOMRect, side: TooltipProps['side']): BalloonPosition {
  switch (side) {
    case 'bottom':
      return { left: triggerRect.left + triggerRect.width / 2, top: triggerRect.bottom + GAP_PX, transform: 'translate(-50%, 0)' };
    case 'left':
      return { left: triggerRect.left - GAP_PX, top: triggerRect.top + triggerRect.height / 2, transform: 'translate(-100%, -50%)' };
    case 'right':
      return { left: triggerRect.right + GAP_PX, top: triggerRect.top + triggerRect.height / 2, transform: 'translate(0, -50%)' };
    case 'top':
    default:
      return { left: triggerRect.left + triggerRect.width / 2, top: triggerRect.top - GAP_PX, transform: 'translate(-50%, -100%)' };
  }
}

/**
 * Replaces the browser's native `title` tooltip with a styled balloon (rounded bubble + pointed
 * tail towards the trigger, same visual language as a WhatsApp chat bubble — pedido do Mozar,
 * 2026-08-29) using the app's own palette instead of OS chrome. Portaled to `document.body` and
 * positioned in viewport coordinates (pedido do Mozar, 2026-08-30) — the balloon always floats
 * above every other container, regardless of z-index/overflow of whatever the trigger happens to
 * sit inside.
 */
export default function Tooltip({ label, children, side = 'top' }: TooltipProps) {
  const [position, setPosition] = useState<BalloonPosition | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPosition(computeBalloonPosition(rect, side));
  }

  function hide() {
    setPosition(null);
  }

  return (
    <span
      ref={triggerRef}
      className="tooltip-wrap"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {position &&
        createPortal(
          <span
            className={`tooltip-balloon tooltip-balloon--${side}`}
            role="tooltip"
            style={{ left: position.left, top: position.top, transform: position.transform }}
          >
            {label}
          </span>,
          document.body
        )}
    </span>
  );
}
