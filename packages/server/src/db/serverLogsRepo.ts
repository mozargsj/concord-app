import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

// Falhas ligadas a um servidor específico — decisions.md §7.
export interface ServerLogRecord {
  server_id: string;
  timestamp: number;
  log_id: string;
  error_type: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
  expires_at: number;
}

function tableName(): string {
  return `${env.dynamodbTablePrefix}server_logs`;
}

export async function create(params: {
  serverId: string;
  errorType: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
}): Promise<void> {
  const timestamp = Date.now();
  const record: ServerLogRecord = {
    server_id: params.serverId,
    timestamp,
    log_id: randomUUID(),
    error_type: params.errorType.slice(0, 200),
    message: params.message.slice(0, 2000),
    stack: params.stack?.slice(0, 8000) ?? null,
    context: params.context,
    expires_at: Math.floor(timestamp / 1000) + RETENTION_SECONDS
  };
  await getDynamoClient().send(new PutCommand({ TableName: tableName(), Item: record }));
}
