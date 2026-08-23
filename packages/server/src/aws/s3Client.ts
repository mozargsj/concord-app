import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, hasAwsRegion } from '../config/env.js';

const UPLOAD_URL_TTL_SECONDS = 300;
const GET_URL_TTL_SECONDS = 3600;

let cachedClient: S3Client | null = null;

/**
 * Lazy accessor: throws only when a caller actually needs S3, not at import time.
 * Credentials come from the EC2 instance role (concord-signaling-role) via the SDK's
 * default provider chain — no static keys. Wire AWS_REGION (see .env.example) to unblock it.
 */
export function getS3Client(): S3Client {
  if (!hasAwsRegion()) {
    throw new Error(
      'S3 client requested but AWS_REGION is not configured yet. ' +
        'Set AWS_REGION in packages/server/.env.'
    );
  }

  if (!cachedClient) {
    cachedClient = new S3Client({ region: env.aws.region });
  }

  return cachedClient;
}

/** The bucket blocks all public access, so the DB only ever stores object keys — every read goes through this. */
export async function createPresignedUploadUrl(key: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: env.s3ServerIconsBucket,
    Key: key,
    ContentType: contentType
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
}

export async function createPresignedGetUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: env.s3ServerIconsBucket, Key: key });
  return getSignedUrl(getS3Client(), command, { expiresIn: GET_URL_TTL_SECONDS });
}

/** Direct upload (no presign) — used only server-side, for importing the Google avatar on signup. */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({ Bucket: env.s3ServerIconsBucket, Key: key, Body: body, ContentType: contentType })
  );
}
