import { S3Client } from '@aws-sdk/client-s3';
import { env, hasAwsRegion } from '../config/env.js';

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
