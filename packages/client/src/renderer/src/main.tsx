import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { reportClientError } from './lib/api';
import './styles/variables.css';
import './styles/global.css';

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
