import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

// Bug/melhoria reportado pelo usuário via UI — decisions.md §7. Separate from system_logs/
// server_logs (those are automatic error capture, this is a person telling us something).
export interface ReportRecord {
  report_id: string;
  user_id: string;
  type: 'bug' | 'suggestion';
  message: string;
  server_id: string | null;
  created_at: number;
  expires_at: number;
}

function tableName(): string {
  return `${env.dynamodbTablePrefix}reports`;
}

export async function create(params: {
  userId: string;
  type: 'bug' | 'suggestion';
  message: string;
  serverId?: string;
}): Promise<void> {
  const createdAt = Date.now();
  const record: ReportRecord = {
    report_id: randomUUID(),
    user_id: params.userId,
    type: params.type,
    message: params.message.slice(0, 2000),
    server_id: params.serverId ?? null,
    created_at: createdAt,
    expires_at: Math.floor(createdAt / 1000) + RETENTION_SECONDS
  };
  await getDynamoClient().send(new PutCommand({ TableName: tableName(), Item: record }));
}
