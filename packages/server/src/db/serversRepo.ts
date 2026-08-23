import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';

export interface ServerRecord {
  server_id: string;
  name: string;
  name_lower: string;
  icon_key: string | null;
  owner_user_id: string;
  created_at: number;
}

function tableName(): string {
  return `${env.dynamodbTablePrefix}servers`;
}

export async function findByNameLower(nameLower: string): Promise<ServerRecord | null> {
  const result = await getDynamoClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'name_lower-index',
      KeyConditionExpression: 'name_lower = :name',
      ExpressionAttributeValues: { ':name': nameLower },
      Limit: 1
    })
  );
  return (result.Items?.[0] as ServerRecord | undefined) ?? null;
}

export async function findById(id: string): Promise<ServerRecord | null> {
  const result = await getDynamoClient().send(
    new GetCommand({ TableName: tableName(), Key: { server_id: id } })
  );
  return (result.Item as ServerRecord | undefined) ?? null;
}

export async function create(params: {
  name: string;
  iconKey: string | null;
  ownerUserId: string;
}): Promise<ServerRecord> {
  const record: ServerRecord = {
    server_id: randomUUID(),
    name: params.name.trim(),
    name_lower: params.name.trim().toLowerCase(),
    icon_key: params.iconKey,
    owner_user_id: params.ownerUserId,
    created_at: Date.now()
  };
  await getDynamoClient().send(new PutCommand({ TableName: tableName(), Item: record }));
  return record;
}

export async function updateName(serverId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  await getDynamoClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { server_id: serverId },
      UpdateExpression: 'SET #name = :name, name_lower = :name_lower',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: { ':name': trimmed, ':name_lower': trimmed.toLowerCase() }
    })
  );
}
