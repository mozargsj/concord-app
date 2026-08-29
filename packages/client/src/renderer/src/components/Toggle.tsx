import { Check, X } from 'lucide-react';
import '../styles/Toggle.css';

interface ToggleProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

// Deliberately a <span>, not a <label> — every current call site already wraps this in its own
// <label> (row text + toggle both clickable), and nesting a <label> inside a <label> is invalid
// HTML. The native <input> below is still a real descendant either way, so the outer label's
// implicit click-to-toggle association keeps working without needing htmlFor/id to match.
export default function Toggle({ id, checked, onChange, disabled }: ToggleProps) {
  return (
    <span className="toggle">
      <input
        id={id}
        type="checkbox"
        className="toggle__input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle__track">
        <span className="toggle__knob">
          {checked ? (
            <Check className="toggle__icon toggle__icon--check" size={12} strokeWidth={3} />
          ) : (
            <X className="toggle__icon toggle__icon--cross" size={12} strokeWidth={3} />
          )}
        </span>
      </span>
    </span>
  );
}
