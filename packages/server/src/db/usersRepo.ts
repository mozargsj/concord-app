import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

/** Exported so serversRepo.ts's cross-table transaction (createOwned) can reference this table
 * name without duplicating the `${prefix}users` convention. */
export function tableName(): string {
  return `${env.dynamodbTablePrefix}users`;
}

function emailLockTableName(): string {
  return `${env.dynamodbTablePrefix}email_locks`;
}

export class UserCreateConflictError extends Error {
  constructor(public reason: 'email-taken') {
    super(reason);
  }
}

function conditionalCheckFailedAt(error: unknown, index: number): boolean {
  const reasons = (error as { CancellationReasons?: { Code?: string }[] } | undefined)?.CancellationReasons;
  return reasons?.[index]?.Code === 'ConditionalCheckFailed';
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

/**
 * [Corrigido, achado de segurança] The old version checked findByEmail then Put separately — two
 * concurrent requests for the same brand-new email could both pass that check before either write
 * landed, creating two user rows for one email (email_lower-index has no uniqueness enforcement
 * of its own, it's just a query index). A DynamoDB ConditionExpression only guards the item being
 * written, never another item sharing an attribute value, so real uniqueness needs a second
 * "reservation" item keyed by the unique value itself — written atomically alongside the real
 * user row via TransactWriteItems. If the lock already exists, the whole transaction is cancelled
 * and nothing is written (see UserCreateConflictError — callers like handleLogin can recover by
 * re-fetching the row the winner just created, since "log in with this email" has a sane fallback
 * that "create a server with this name" doesn't).
 */
export async function create(params: { email: string; displayName: string }): Promise<UserRecord> {
  const emailLower = params.email.trim().toLowerCase();
  const record: UserRecord = {
    user_id: randomUUID(),
    email: params.email.trim(),
    email_lower: emailLower,
    display_name: params.displayName.trim().slice(0, 60),
    avatar_key: null,
    owned_server_id: null,
    created_at: Date.now()
  };
  try {
    await getDynamoClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: emailLockTableName(),
              Item: { email_lower: emailLower, user_id: record.user_id },
              ConditionExpression: 'attribute_not_exists(email_lower)'
            }
          },
          { Put: { TableName: tableName(), Item: record } }
        ]
      })
    );
  } catch (error) {
    if (conditionalCheckFailedAt(error, 0)) throw new UserCreateConflictError('email-taken');
    throw error;
  }
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
