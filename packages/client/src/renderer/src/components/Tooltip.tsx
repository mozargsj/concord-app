import { useState, type ReactNode } from 'react';
import '../styles/Tooltip.css';

interface TooltipProps {
  label: string;
  children: ReactNode;
  /** Which side of the trigger the balloon opens on — 'top' fits most toolbar/icon-row contexts
   * (balloon has room above, tail points down at the icon); pick 'bottom'/'left'/'right' for
   * triggers near an edge where 'top' would clip. */
  side?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Replaces the browser's native `title` tooltip with a styled balloon (rounded bubble + pointed
 * tail towards the trigger, same visual language as a WhatsApp chat bubble — pedido do Mozar,
 * 2026-08-29) using the app's own palette instead of OS chrome. Pure CSS positioning (no portal) —
 * fine for every current use (toolbar/list-row icon buttons in normal document flow); a trigger
 * inside a strict `overflow: hidden` container could clip the balloon, same limitation the native
 * `title` attribute never had, not hit by any current call site.
 */
export default function Tooltip({ label, children, side = 'top' }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <span
      className="tooltip-wrap"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onFocus={() => setIsVisible(true)}
      onBlur={() => setIsVisible(false)}
    >
      {children}
      {isVisible && (
        <span className={`tooltip-balloon tooltip-balloon--${side}`} role="tooltip">
          {label}
        </span>
      )}
    </span>
  );
}
