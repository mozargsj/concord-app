import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { reportClientError } from './lib/api';
import { primeAudioContext } from './lib/soundEffects';
import './styles/variables.css';
import './styles/global.css';

// Unlocks the shared AudioContext on the app's first real interaction — see the doc comment on
// primeAudioContext for why this matters (peer-joined/peer-left otherwise play into a suspended
// context and produce no audible sound the first time). `once` on both since whichever fires
// first is enough; a second call on an already-running context is a harmless no-op anyway.
window.addEventListener('pointerdown', primeAudioContext, { once: true });
window.addEventListener('keydown', primeAudioContext, { once: true });

// Safety net for anything that escapes every local try/catch in the app — decisions.md §7.
window.addEventListener('error', (event) => {
  void reportClientError(event.error?.name ?? 'Error', event.message, event.error?.stack);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const isError = reason instanceof Error;
  void reportClientError(
    isError ? reason.name : 'UnhandledRejection',
    isError ? reason.message : String(reason),
    isError ? reason.stack : undefined
  );
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
