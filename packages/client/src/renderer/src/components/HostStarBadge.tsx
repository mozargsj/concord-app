interface HostStarBadgeProps {
  className?: string;
}

/** Marks whoever is host of the room's mesh — decisions.md: "host = primeiro peer a conectar". */
export default function HostStarBadge({ className }: HostStarBadgeProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" role="img">
      <title>Host da sala</title>
      <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.2 1.3-6.6L2.5 9.4l6.6-.8L12 2.5z" />
    </svg>
  );
}
