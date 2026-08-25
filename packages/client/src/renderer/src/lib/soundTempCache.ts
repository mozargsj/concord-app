import { generateSoundId, saveOwnSound } from './soundCache';
import type { TempSoundMeta } from '../types/window';

export interface TempSound extends TempSoundMeta {
  /** blob: URL for plain <audio> preview playback. */
  url: string;
}

const objectUrlById = new Map<string, string>();

function trackObjectUrl(id: string, url: string): void {
  const previous = objectUrlById.get(id);
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  objectUrlById.set(id, url);
}

/** Everything currently downloaded-but-not-adopted — the 7-day expiry itself is enforced on the
 * main process side (swept once at app startup), this just reads whatever's still there. */
export async function listTempSounds(): Promise<TempSound[]> {
  const cached = await window.concord.soundTempCache.list();
  return cached.map(({ data, ...meta }) => {
    const url = URL.createObjectURL(new Blob([data], { type: meta.mimeType }));
    trackObjectUrl(meta.id, url);
    return { ...meta, url };
  });
}

/** Stashes a just-downloaded peer sound for preview — separate from "meus áudios" until the
 * user explicitly confirms adopting it (decisions.md: baixar ≠ adicionar à lista própria). */
export async function saveTempSound(meta: Omit<TempSoundMeta, 'downloadedAt'>, data: ArrayBuffer): Promise<TempSound> {
  const fullMeta: TempSoundMeta = { ...meta, downloadedAt: Date.now() };
  await window.concord.soundTempCache.save(fullMeta, data);
  const url = URL.createObjectURL(new Blob([data], { type: meta.mimeType }));
  trackObjectUrl(meta.id, url);
  return { ...fullMeta, url };
}

export async function deleteTempSound(id: string): Promise<void> {
  await window.concord.soundTempCache.delete(id);
  const url = objectUrlById.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrlById.delete(id);
  }
}

/** Confirms adoption: copies the temp bytes into "meus áudios" under a fresh id (each user's
 * registry is its own independent set of entries — see decisions.md) with the volume the user
 * just chose, then clears the temp copy. The name/emoji default to the peer's own but are
 * editable right up to this call (see ConfirmAddSoundModal). */
export async function promoteTempSound(
  temp: TempSound,
  overrides: { name: string; emoji: string; volume: number }
): Promise<void> {
  const bytes = await fetch(temp.url).then((response) => response.arrayBuffer());
  await saveOwnSound(
    {
      id: generateSoundId(),
      name: overrides.name,
      emoji: overrides.emoji,
      volume: overrides.volume,
      durationMs: temp.durationMs,
      mimeType: temp.mimeType
    },
    bytes
  );
  await deleteTempSound(temp.id);
}
