export type ImageCacheKind = 'avatar' | 'server-icon';

export interface CachedImageEntry {
  url: string;
  hash: string;
}

// One object URL per key at a time — a stale one is revoked whenever a fresher image replaces
// it, so the tab doesn't leak a blob URL every time an avatar/icon is re-fetched.
const objectUrlByKey = new Map<string, string>();

function cacheKey(kind: ImageCacheKind, ownerId: string): string {
  return `${kind}_${ownerId}`;
}

/** Reads back the bytes behind any fetchable URL (a blob: URL from this same session, or a
 * plain http(s) one) — used to answer a peer's image request with whatever's currently set as
 * my avatar/my server's icon, wherever that URL happens to point. */
export async function fetchImageBytes(url: string): Promise<{ data: ArrayBuffer; mimeType: string; hash: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    const data = await blob.arrayBuffer();
    return { data, mimeType: blob.type || 'image/png', hash: await hashBytes(data) };
  } catch {
    return null;
  }
}

export async function hashBytes(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function trackObjectUrl(key: string, url: string): void {
  const previous = objectUrlByKey.get(key);
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  objectUrlByKey.set(key, url);
}

/** Reads whatever's on disk for this owner, if anything — from a previous P2P download or a
 * previous local pick, persisted across app restarts (unlike blob URLs). */
export async function loadCachedImage(kind: ImageCacheKind, ownerId: string): Promise<CachedImageEntry | null> {
  const key = cacheKey(kind, ownerId);
  const cached = await window.concord.imageCache.load(key);
  if (!cached) return null;
  const url = URL.createObjectURL(new Blob([cached.data], { type: cached.mimeType }));
  trackObjectUrl(key, url);
  return { url, hash: await hashBytes(cached.data) };
}

/** Writes to disk (persists across restarts) and returns an object URL for immediate display. */
export async function saveCachedImage(
  kind: ImageCacheKind,
  ownerId: string,
  data: ArrayBuffer,
  mimeType: string
): Promise<CachedImageEntry> {
  const key = cacheKey(kind, ownerId);
  await window.concord.imageCache.save(key, data, mimeType);
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
  trackObjectUrl(key, url);
  return { url, hash: await hashBytes(data) };
}
