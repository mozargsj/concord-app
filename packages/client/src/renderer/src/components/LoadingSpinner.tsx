import type { CSSProperties } from 'react';
import logoSpinner from '../assets/images/logo-spinner.png';
import '../styles/LoadingSpinner.css';

interface LoadingSpinnerProps {
  message?: string;
  /** 0-100. Only meaningful while a download is actually in progress — omit otherwise, the bar
   * doesn't render without a real number to show (no fake/indeterminate fill). */
  percent?: number;
  /** Defaults to the plain logo — App.tsx's update screen passes the "gato mecânico" art
   * (update-spinner.png) instead, since spinning the bare logo during an actual download/install
   * didn't really say "working on it" the way a cat with a wrench does. */
  icon?: string;
}

export default function LoadingSpinner({ message, percent, icon }: LoadingSpinnerProps) {
  return (
    <div className="loading-spinner">
      <img src={icon ?? logoSpinner} alt="" className="loading-spinner__logo" />
      {message && <p className="loading-spinner__message">{message}</p>}
      {percent !== undefined && (
        <div className="loading-spinner__progress">
          <div
            className="loading-spinner__progress-fill"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{ '--percent': `${percent}%` } as CSSProperties}
          />
          <span className="loading-spinner__progress-label">{percent}%</span>
        </div>
      )}
    </div>
  );
}
