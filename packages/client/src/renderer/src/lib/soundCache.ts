import { hashBytes } from './imageCache';
import type { SoundMeta } from '../types/window';

export interface OwnSound extends SoundMeta {
  /** blob: URL for plain <audio> playback/preview — not suitable for the WebRTC mixing path,
   * which needs a decoded AudioBuffer (see loadOwnSoundBytes + lib/audioClip.ts). */
  url: string;
}

const objectUrlById = new Map<string, string>();

function trackObjectUrl(id: string, url: string): void {
  const previous = objectUrlById.get(id);
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  objectUrlById.set(id, url);
}

export function generateSoundId(): string {
  return crypto.randomUUID();
}

/** Local-only for now (Fase A) — no backend registry yet, this is 100% disk-backed via the
 * same main-process cache pattern as avatar/server-icon (decisions.md). */
export async function listOwnSounds(): Promise<OwnSound[]> {
  const cached = await window.concord.soundCache.list();
  return cached.map(({ data, ...meta }) => {
    const url = URL.createObjectURL(new Blob([data], { type: meta.mimeType }));
    trackObjectUrl(meta.id, url);
    return { ...meta, url };
  });
}

export async function saveOwnSound(meta: Omit<SoundMeta, 'hash'>, data: ArrayBuffer): Promise<OwnSound> {
  const hash = await hashBytes(data);
  const fullMeta: SoundMeta = { ...meta, hash };
  await window.concord.soundCache.save(fullMeta, data);
  const url = URL.createObjectURL(new Blob([data], { type: meta.mimeType }));
  trackObjectUrl(meta.id, url);
  return { ...fullMeta, url };
}

export async function updateOwnSoundMeta(
  id: string,
  patch: Partial<Pick<SoundMeta, 'name' | 'emoji' | 'volume'>>
): Promise<void> {
  await window.concord.soundCache.updateMeta(id, patch);
}

export async function deleteOwnSound(id: string): Promise<void> {
  await window.concord.soundCache.delete(id);
  const url = objectUrlById.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrlById.delete(id);
  }
}

/** Raw bytes for decoding into an AudioBuffer — the "tocar como microfone" path needs actual
 * PCM samples to mix, which a blob URL alone can't give it. */
export async function loadOwnSoundBytes(id: string): Promise<{ data: ArrayBuffer; mimeType: string } | null> {
  return window.concord.soundCache.loadBytes(id);
}
