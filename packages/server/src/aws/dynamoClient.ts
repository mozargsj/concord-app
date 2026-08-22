import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { env, hasAwsRegion } from '../config/env.js';

let cachedClient: DynamoDBDocumentClient | null = null;

/**
 * Lazy accessor: throws only when a caller actually needs DynamoDB, not at import time.
 * Credentials come from the EC2 instance role (concord-signaling-role) via the SDK's
 * default provider chain — no static keys. Wire AWS_REGION (see .env.example) to unblock it.
 */
export function getDynamoClient(): DynamoDBDocumentClient {
  if (!hasAwsRegion()) {
    throw new Error(
      'DynamoDB client requested but AWS_REGION is not configured yet. ' +
        'Set AWS_REGION in packages/server/.env.'
    );
  }

  if (!cachedClient) {
    const base = new DynamoDBClient({ region: env.aws.region });
    cachedClient = DynamoDBDocumentClient.from(base);
  }

  return cachedClient;
}
