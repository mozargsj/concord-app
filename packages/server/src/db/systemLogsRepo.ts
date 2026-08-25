import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

// Falhas de infraestrutura gerais, não ligadas a um servidor específico — decisions.md §7.
export interface SystemLogRecord {
  log_id: string;
  error_type: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
  created_at: number;
  expires_at: number;
}

function tableName(): string {
  return `${env.dynamodbTablePrefix}system_logs`;
}

export async function create(params: {
  errorType: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
}): Promise<void> {
  const createdAt = Date.now();
  const record: SystemLogRecord = {
    log_id: randomUUID(),
    error_type: params.errorType.slice(0, 200),
    message: params.message.slice(0, 2000),
    stack: params.stack?.slice(0, 8000) ?? null,
    context: params.context,
    created_at: createdAt,
    expires_at: Math.floor(createdAt / 1000) + RETENTION_SECONDS
  };
  await getDynamoClient().send(new PutCommand({ TableName: tableName(), Item: record }));
}
