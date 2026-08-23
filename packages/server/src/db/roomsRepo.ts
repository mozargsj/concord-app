import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';

export interface RoomRecord {
  server_id: string;
  room_id: string;
  name: string;
  created_at: number;
}

function tableName(): string {
  return `${env.dynamodbTablePrefix}rooms`;
}

export async function listByServer(serverId: string): Promise<RoomRecord[]> {
  const result = await getDynamoClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'server_id = :server_id',
      ExpressionAttributeValues: { ':server_id': serverId }
    })
  );
  return (result.Items as RoomRecord[] | undefined) ?? [];
}

export async function findById(serverId: string, roomId: string): Promise<RoomRecord | null> {
  const result = await getDynamoClient().send(
    new GetCommand({ TableName: tableName(), Key: { server_id: serverId, room_id: roomId } })
  );
  return (result.Item as RoomRecord | undefined) ?? null;
}

export async function create(params: { serverId: string; name: string }): Promise<RoomRecord> {
  const record: RoomRecord = {
    server_id: params.serverId,
    room_id: randomUUID(),
    name: params.name.trim().slice(0, 60),
    created_at: Date.now()
  };
  await getDynamoClient().send(new PutCommand({ TableName: tableName(), Item: record }));
  return record;
}

export async function updateName(serverId: string, roomId: string, name: string): Promise<void> {
  await getDynamoClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { server_id: serverId, room_id: roomId },
      UpdateExpression: 'SET #name = :name',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: { ':name': name.trim().slice(0, 60) }
    })
  );
}

export async function remove(serverId: string, roomId: string): Promise<void> {
  await getDynamoClient().send(
    new DeleteCommand({ TableName: tableName(), Key: { server_id: serverId, room_id: roomId } })
  );
}
