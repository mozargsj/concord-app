import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';

interface RoleRecord {
  server_id: string;
  user_id: string;
  rank: number;
}

function tableName(): string {
  return `${env.dynamodbTablePrefix}roles`;
}

export async function getRank(serverId: string, userId: string): Promise<number | null> {
  const result = await getDynamoClient().send(
    new GetCommand({ TableName: tableName(), Key: { server_id: serverId, user_id: userId } })
  );
  const record = result.Item as RoleRecord | undefined;
  return record?.rank ?? null;
}

export async function setRank(serverId: string, userId: string, rank: number): Promise<void> {
  const record: RoleRecord = { server_id: serverId, user_id: userId, rank };
  await getDynamoClient().send(new PutCommand({ TableName: tableName(), Item: record }));
}
