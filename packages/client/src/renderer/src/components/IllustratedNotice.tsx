import { useState } from 'react';
import '../styles/IllustratedNotice.css';

interface IllustratedNoticeProps {
  icon: string;
  messages: string[];
  /** The precise, non-funny explanation (e.g. "Só admins ou o dono podem gerar convites.") —
   * shown alongside the joke, not instead of it, so the user still knows exactly what happened. */
  detail?: string;
  /** 'row' (default): small icon beside the text — fits inline under a field in an otherwise-busy
   * modal (InviteCodeModal, EditServerModal). 'column': bigger icon centered above the text — for
   * a notice that's the *entire* content of its own modal (LoginFailedModal), where there's
   * nothing else competing for space. */
  layout?: 'row' | 'column';
}

/** Compact icon+text notice for action-level errors (a modal's "this one thing failed"), as
 * opposed to the full-screen takeovers in FullScreenNotice.css (ServerOfflineScreen,
 * SessionExpiredScreen) reserved for "the whole app is unusable right now". Rotates through the
 * same message-bank pattern as those, one pick per mount. */
export default function IllustratedNotice({ icon, messages, detail, layout = 'row' }: IllustratedNoticeProps) {
  const [message] = useState(() => messages[Math.floor(Math.random() * messages.length)]);

  return (
    <div className={`illustrated-notice illustrated-notice--${layout}`}>
      <img src={icon} alt="" className="illustrated-notice__icon" />
      <div className="illustrated-notice__text">
        <p className="illustrated-notice__message">{message}</p>
        {detail && <p className="illustrated-notice__detail">{detail}</p>}
      </div>
    </div>
  );
}
