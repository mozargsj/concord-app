import { Music2 } from 'lucide-react';
import '../styles/LiveBadge.css';

interface LiveBadgeProps {
  className?: string;
  // 'text' (default) — the dot + "AO VIVO" badge, used in RoomSidebar rows and RoomView's screen
  // tile corner. 'icon' — same red pulsing treatment but as a bare Music2 icon, no text — only for
  // the "Music <nome>" row (RoomSidebar), where the music note actually matches what's being
  // shared. [Bug corrigido, achado pelo Mozar] RoomView's screen tile briefly used this variant
  // too, showing a music note over a screen share — wrong icon for what's actually live.
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
