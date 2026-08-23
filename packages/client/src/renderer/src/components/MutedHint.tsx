import '../styles/MutedHint.css';

/** Rendered by a `position: relative` ancestor next to a mic button — tells the user their
 * mic is picking up sound even though nothing is being sent (mute only stops the send, capture
 * keeps running, per decisions.md). */
export default function MutedHint() {
  return (
    <div className="muted-hint" role="status">
      Microfone desativado — ninguém está ouvindo
    </div>
  );
}
