import type { UploadKind } from '@concord/shared';
import { presignUpload, uploadToPresignedUrl } from './api';

/** Opens the native file picker, uploads the chosen image straight to S3 via a presigned URL, and returns its object key. */
export async function pickAndUploadImage(kind: UploadKind, id: string): Promise<string | null> {
  const picked = await window.concord.media.pickImage();
  if (!picked) return null;

  const { uploadUrl, key } = await presignUpload(kind, id, picked.mimeType);
  await uploadToPresignedUrl(uploadUrl, picked.data, picked.mimeType);
  return key;
}
