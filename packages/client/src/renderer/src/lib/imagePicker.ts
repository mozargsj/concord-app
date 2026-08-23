export interface PickedImageFile {
  data: ArrayBuffer;
  mimeType: string;
}

/** Opens the native file picker and returns the raw chosen image — no network call, no disk
 * write. Callers decide when/how to cache it (see imageCache.ts): immediately, for an owner
 * whose id is already known (profile avatar), or deferred until an id exists (a new server's
 * icon, picked before the server itself is created). */
export async function pickImageFile(): Promise<PickedImageFile | null> {
  const picked = await window.concord.media.pickImage();
  if (!picked) return null;
  return { data: picked.data, mimeType: picked.mimeType };
}
