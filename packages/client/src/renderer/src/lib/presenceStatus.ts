import type { PresenceStatus } from '@concord/shared';

// Profile presence status (remote-control spec 13.5). Persisted locally: the app restores the last
// status the user picked on startup, 'online' the very first time. Same module-level pub/sub shape
// as micGain.ts — ProfilePage writes it, ServerListPage subscribes and forwards it to the room
// (signaling) and to the main process (remote-control gate).
const STORAGE_KEY = 'concord.presence.status';

export const PRESENCE_STATUSES: PresenceStatus[] = ['online', 'busy', 'unavailable', 'offline'];

export const PRESENCE_LABELS: Record<PresenceStatus, string> = {
  online: 'Online',
  busy: 'Ocupado',
  unavailable: 'Indisponível',
  offline: 'Offline'
};

/** Dot colors: verde, laranja, vermelho, cinza claro. */
export const PRESENCE_COLORS: Record<PresenceStatus, string> = {
  online: '#3ba55d',
  busy: '#f0883e',
  unavailable: '#da373c',
  offline: '#b5bac1'
};

export function getPresenceStatus(): PresenceStatus {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return PRESENCE_STATUSES.find((status) => status === raw) ?? 'online';
  } catch {
    return 'online';
  }
}

const listeners = new Set<(status: PresenceStatus) => void>();

export function setPresenceStatus(status: PresenceStatus): void {
  try {
    localStorage.setItem(STORAGE_KEY, status);
  } catch {
    // storage unavailable — the status still applies for this session through the listeners
  }
  for (const listener of listeners) listener(status);
}

export function onPresenceStatusChange(listener: (status: PresenceStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
