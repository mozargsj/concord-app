import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { env, hasAwsCredentials } from '../config/env.js';

let cachedClient: DynamoDBDocumentClient | null = null;

/**
 * Lazy accessor: throws only when a caller actually needs DynamoDB, not at import time.
 * Wire AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (see .env.example) to unblock it.
 */
export function getDynamoClient(): DynamoDBDocumentClient {
  if (!hasAwsCredentials()) {
    throw new Error(
      'DynamoDB client requested but AWS credentials are not configured yet. ' +
        'Set AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in packages/server/.env.'
    );
  }

  if (!cachedClient) {
    const base = new DynamoDBClient({
      region: env.aws.region,
      credentials: {
        accessKeyId: env.aws.accessKeyId,
        secretAccessKey: env.aws.secretAccessKey
      }
    });
    cachedClient = DynamoDBDocumentClient.from(base);
  }

  return cachedClient;
}
