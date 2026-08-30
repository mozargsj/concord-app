interface SmartAppControlIconProps {
  /** true = Smart App Control ativo (vermelho, pode estar bloqueando recursos), false = inativo (verde). */
  active: boolean;
  size?: number;
}

/** Escudo com check, mesmo desenho do ícone de referência do Mozar — recolorido por estado em vez
 * de estático, já que aqui ele serve de indicador (vermelho = ativo, verde = inativo). */
export default function SmartAppControlIcon({ active, size = 20 }: SmartAppControlIconProps) {
  const color = active ? 'var(--color-danger)' : 'var(--color-online)';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.2l7.2 2.88v5.36c0 5.06-3.02 9.62-7.2 11.36-4.18-1.74-7.2-6.3-7.2-11.36V5.08L12 2.2z"
        fill={color}
      />
      <path
        d="M8.3 12.3l2.55 2.55 4.85-5.1"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
