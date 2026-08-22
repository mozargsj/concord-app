import { S3Client } from '@aws-sdk/client-s3';
import { env, hasAwsCredentials } from '../config/env.js';

let cachedClient: S3Client | null = null;

/**
 * Lazy accessor: throws only when a caller actually needs S3, not at import time.
 * Wire AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (see .env.example) to unblock it.
 */
export function getS3Client(): S3Client {
  if (!hasAwsCredentials()) {
    throw new Error(
      'S3 client requested but AWS credentials are not configured yet. ' +
        'Set AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in packages/server/.env.'
    );
  }

  if (!cachedClient) {
    cachedClient = new S3Client({
      region: env.aws.region,
      credentials: {
        accessKeyId: env.aws.accessKeyId,
        secretAccessKey: env.aws.secretAccessKey
      }
    });
  }

  return cachedClient;
}
