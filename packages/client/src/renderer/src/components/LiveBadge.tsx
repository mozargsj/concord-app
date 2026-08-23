import '../styles/LiveBadge.css';

interface LiveBadgeProps {
  className?: string;
}

export default function LiveBadge({ className }: LiveBadgeProps) {
  return (
    <div className={'live-badge' + (className ? ` ${className}` : '')} title="Transmitindo">
      <span className="live-badge__dot" />
      AO VIVO
    </div>
  );
}
