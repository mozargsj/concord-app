import logoSpinner from '../assets/images/logo-spinner.png';
import '../styles/LoadingSpinner.css';

interface LoadingSpinnerProps {
  message?: string;
}

export default function LoadingSpinner({ message }: LoadingSpinnerProps) {
  return (
    <div className="loading-spinner">
      <img src={logoSpinner} alt="" className="loading-spinner__logo" />
      {message && <p className="loading-spinner__message">{message}</p>}
    </div>
  );
}
