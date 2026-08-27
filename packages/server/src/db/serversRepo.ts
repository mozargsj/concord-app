import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';
import { tableName as usersTableName } from './usersRepo.js';

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

function nameLockTableName(): string {
  return `${env.dynamodbTablePrefix}server_name_locks`;
}

export class ServerCreateConflictError extends Error {
  constructor(public reason: 'name-taken' | 'already-owns-server') {
    super(reason);
  }
}

function conditionalCheckFailedAt(error: unknown, index: number): boolean {
  const reasons = (error as { CancellationReasons?: { Code?: string }[] } | undefined)?.CancellationReasons;
  return reasons?.[index]?.Code === 'ConditionalCheckFailed';
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

/**
 * [Corrigido, achado de segurança] The old create() paired with a separate usersRepo.setOwnedServer
 * call in handleCreateServer — both preceded by "does this already exist?" checks that ran before
 * either write. Two concurrent create-server requests (double-click, retry, whatever) could both
 * pass those checks before either committed, producing two servers with the same name, or two
 * servers both owned by the same user (owned_server_id only ever reflects whichever write ran
 * last). This does all three writes — the name uniqueness lock, the server row, and the owner's
 * owned_server_id — as one DynamoDB transaction: if the name is already locked, or the owner
 * already has an owned_server_id set, the whole thing is cancelled and nothing is written.
 * ServerCreateConflictError.reason tells the caller which one failed (inspected via
 * TransactWriteCommand's CancellationReasons, positional to TransactItems below).
 */
export async function createOwned(params: {
  name: string;
  iconKey: string | null;
  ownerUserId: string;
}): Promise<ServerRecord> {
  const trimmed = params.name.trim();
  const nameLower = trimmed.toLowerCase();
  const record: ServerRecord = {
    server_id: randomUUID(),
    name: trimmed,
    name_lower: nameLower,
    icon_key: params.iconKey,
    owner_user_id: params.ownerUserId,
    created_at: Date.now()
  };

  try {
    await getDynamoClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: nameLockTableName(),
              Item: { name_lower: nameLower, server_id: record.server_id },
              ConditionExpression: 'attribute_not_exists(name_lower)'
            }
          },
          {
            Update: {
              TableName: usersTableName(),
              Key: { user_id: params.ownerUserId },
              UpdateExpression: 'SET owned_server_id = :server_id',
              ConditionExpression: 'attribute_not_exists(owned_server_id)',
              ExpressionAttributeValues: { ':server_id': record.server_id }
            }
          },
          { Put: { TableName: tableName(), Item: record } }
        ]
      })
    );
  } catch (error) {
    if (conditionalCheckFailedAt(error, 0)) throw new ServerCreateConflictError('name-taken');
    if (conditionalCheckFailedAt(error, 1)) throw new ServerCreateConflictError('already-owns-server');
    throw error;
  }

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
