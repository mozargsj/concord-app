import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';

interface AuthorizedUserRecord {
  server_id: string;
  user_id: string;
  authorized_at: number;
}

function tableName(): string {
  return `${env.dynamodbTablePrefix}authorized_users`;
}

export async function authorize(serverId: string, userId: string): Promise<void> {
  const record: AuthorizedUserRecord = { server_id: serverId, user_id: userId, authorized_at: Date.now() };
  await getDynamoClient().send(new PutCommand({ TableName: tableName(), Item: record }));
}

/** Every server this user is a member of (owner included — owners are authorized at server-creation time too). */
export async function listServerIdsForUser(userId: string): Promise<string[]> {
  const result = await getDynamoClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'user_id-index',
      KeyConditionExpression: 'user_id = :user_id',
      ExpressionAttributeValues: { ':user_id': userId }
    })
  );
  return (result.Items as AuthorizedUserRecord[] | undefined)?.map((item) => item.server_id) ?? [];
}
