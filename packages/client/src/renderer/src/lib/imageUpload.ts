import type { UploadKind } from '@concord/shared';
import { presignUpload, uploadToPresignedUrl } from './api';

/**
 * Opens the native file picker, uploads the chosen image straight to S3 via a presigned URL,
 * and returns its object key. `onPicked` fires right after the file is chosen — before the
 * upload even starts — with a local object URL, so callers can show an instant preview instead
 * of waiting on the upload (and later, on the server round-trip that resolves a real URL).
 */
export async function pickAndUploadImage(
  kind: UploadKind,
  id: string,
  onPicked?: (previewUrl: string) => void
): Promise<string | null> {
  const picked = await window.concord.media.pickImage();
  if (!picked) return null;

  onPicked?.(URL.createObjectURL(new Blob([picked.data], { type: picked.mimeType })));

  const { uploadUrl, key } = await presignUpload(kind, id, picked.mimeType);
  await uploadToPresignedUrl(uploadUrl, picked.data, picked.mimeType);
  return key;
}
