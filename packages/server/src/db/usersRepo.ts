import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';

export interface UserRecord {
  user_id: string;
  email: string;
  email_lower: string;
  display_name: string;
  avatar_key: string | null;
  owned_server_id: string | null;
  created_at: number;
}

function tableName(): string {
  return `${env.dynamodbTablePrefix}users`;
}

export async function findByEmail(email: string): Promise<UserRecord | null> {
  const result = await getDynamoClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'email_lower-index',
      KeyConditionExpression: 'email_lower = :email',
      ExpressionAttributeValues: { ':email': email.trim().toLowerCase() },
      Limit: 1
    })
  );
  return (result.Items?.[0] as UserRecord | undefined) ?? null;
}

export async function findById(id: string): Promise<UserRecord | null> {
  const result = await getDynamoClient().send(
    new GetCommand({ TableName: tableName(), Key: { user_id: id } })
  );
  return (result.Item as UserRecord | undefined) ?? null;
}

export async function create(params: { email: string; displayName: string }): Promise<UserRecord> {
  const record: UserRecord = {
    user_id: randomUUID(),
    email: params.email.trim(),
    email_lower: params.email.trim().toLowerCase(),
    display_name: params.displayName.trim().slice(0, 60),
    avatar_key: null,
    owned_server_id: null,
    created_at: Date.now()
  };
  await getDynamoClient().send(new PutCommand({ TableName: tableName(), Item: record }));
  return record;
}

export async function updateProfile(
  id: string,
  patch: { displayName?: string; avatarKey?: string }
): Promise<void> {
  const sets: string[] = [];
  const values: Record<string, unknown> = {};

  if (patch.displayName !== undefined) {
    sets.push('display_name = :display_name');
    values[':display_name'] = patch.displayName.trim().slice(0, 60);
  }
  if (patch.avatarKey !== undefined) {
    sets.push('avatar_key = :avatar_key');
    values[':avatar_key'] = patch.avatarKey;
  }
  if (sets.length === 0) return;

  await getDynamoClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { user_id: id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values
    })
  );
}

export async function setOwnedServer(id: string, serverId: string): Promise<void> {
  await getDynamoClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { user_id: id },
      UpdateExpression: 'SET owned_server_id = :server_id',
      ExpressionAttributeValues: { ':server_id': serverId }
    })
  );
}
