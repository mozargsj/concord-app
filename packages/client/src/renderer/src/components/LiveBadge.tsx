import { Music2 } from 'lucide-react';
import '../styles/LiveBadge.css';

interface LiveBadgeProps {
  className?: string;
  // 'text' (default) — the dot + "AO VIVO" badge used in RoomSidebar rows. 'icon' — same red
  // pulsing treatment but as a bare icon (same glyph used everywhere else for "audio share" in
  // the app), no text — pedido do Mozar pro canto do tile de tela em RoomView, pra não competir
  // por espaço/atenção com o resto do overlay do tile.
  variant?: 'text' | 'icon';
}

export default function LiveBadge({ className, variant = 'text' }: LiveBadgeProps) {
  const classes = 'live-badge' + (variant === 'icon' ? ' live-badge--icon' : '') + (className ? ` ${className}` : '');
  return (
    <div className={classes} title="Transmitindo">
      {variant === 'icon' ? (
        <Music2 size={14} className="live-badge__icon" />
      ) : (
        <>
          <span className="live-badge__dot" />
          AO VIVO
        </>
      )}
    </div>
  );
}
