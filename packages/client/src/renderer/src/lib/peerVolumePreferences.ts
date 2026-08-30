const STORAGE_KEY = 'concord.audio.peerVolumes';

export interface PeerVolumeSettings {
  // [2026-08-30, pedido do Mozar] 0-200 — acima de 100 é ganho de verdade (MediaStreamVideo.tsx
  // roteia por um GainNode em vez do <video>.volume nativo, que trava em 1.0/100%), não só um
  // controle de "abaixar o volume" como antes.
  volume: number;
  muted: boolean;
}

const DEFAULT_SETTINGS: PeerVolumeSettings = { volume: 100, muted: false };

// Keyed by userId (stable across reconnects/sessions), not peerId (random per connection) — a
// listener's choice to mute/turn down a specific person should survive that person reconnecting.
// Local-only by design: adjusting someone's volume here never affects what anyone else in the
// room hears from them, and never touches the mesh/signaling — it's purely how this listener's
// own client mixes incoming audio.
function readAll(): Record<string, PeerVolumeSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, PeerVolumeSettings>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // best-effort — a full localStorage or serialization hiccup shouldn't break playback
  }
}

export function getPeerVolumeSettings(userId: string): PeerVolumeSettings {
  return readAll()[userId] ?? DEFAULT_SETTINGS;
}

export function setPeerVolume(userId: string, volume: number): void {
  const all = readAll();
  all[userId] = { ...(all[userId] ?? DEFAULT_SETTINGS), volume };
  writeAll(all);
}

export function setPeerMuted(userId: string, muted: boolean): void {
  const all = readAll();
  all[userId] = { ...(all[userId] ?? DEFAULT_SETTINGS), muted };
  writeAll(all);
}
