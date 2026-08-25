import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { env, hasAwsRegion } from '../config/env.js';

let cachedClient: DynamoDBDocumentClient | null = null;

/**
 * Lazy accessor: throws only when a caller actually needs DynamoDB, not at import time.
 * Credentials come from the EC2 instance role (concord-signaling-role) via the SDK's
 * default provider chain — no static keys. Wire AWS_REGION (see .env.example) to unblock it.
 *
 * DYNAMODB_ENDPOINT (optional) points this at DynamoDB Local instead — used for local testing
 * without AWS. Static dummy credentials are needed in that case because DynamoDB Local doesn't
 * validate them but the SDK still requires something resolvable, and a dev machine's real AWS
 * CLI auth state is irrelevant here. Production (no DYNAMODB_ENDPOINT set) is unaffected.
 */
export function getDynamoClient(): DynamoDBDocumentClient {
  if (!hasAwsRegion()) {
    throw new Error(
      'DynamoDB client requested but AWS_REGION is not configured yet. ' +
        'Set AWS_REGION in packages/server/.env.'
    );
  }

  if (!cachedClient) {
    const base = new DynamoDBClient({
      region: env.aws.region,
      ...(env.aws.dynamodbEndpoint
        ? {
            endpoint: env.aws.dynamodbEndpoint,
            credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
          }
        : {})
    });
    // Without this, PutCommand/UpdateCommand throw the moment any item has an `undefined` field
    // (e.g. optional error-log context) instead of just omitting that attribute — surfaced by
    // the new logging repos (systemLogsRepo/serverLogsRepo), but a safe default for every caller.
    cachedClient = DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
  }

  return cachedClient;
}
