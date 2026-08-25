import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from '../aws/dynamoClient.js';
import { env } from '../config/env.js';

// Only the registry (metadata) lives here — the audio bytes themselves never touch the backend,
// same P2P-only architecture already used for avatar/server-icon (decisions.md, seção 3/4). This
// table exists purely so a user's own "meus áudios" list can survive a fresh install/reinstall
// (metadata, not the files) and so a future device sync has something to read.
export interface UserSoundRecord {
  user_id: string;
  sound_id: string;
  name: string;
  emoji: string;
  volume: number;
  duration_ms: number;
  hash: string;
  created_at: number;
}

function tableName(): string {
  return `${env.dynamodbTablePrefix}user_sounds`;
}

export async function listByUser(userId: string): Promise<UserSoundRecord[]> {
  const result = await getDynamoClient().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'user_id = :user_id',
      ExpressionAttributeValues: { ':user_id': userId }
    })
  );
  return (result.Items as UserSoundRecord[] | undefined) ?? [];
}

export async function create(params: {
  userId: string;
  soundId: string;
  name: string;
  emoji: string;
  volume: number;
  durationMs: number;
  hash: string;
}): Promise<UserSoundRecord> {
  const record: UserSoundRecord = {
    user_id: params.userId,
    sound_id: params.soundId,
    name: params.name.trim().slice(0, 60),
    emoji: params.emoji.slice(0, 8),
    volume: Math.max(0, Math.min(1, params.volume)),
    duration_ms: params.durationMs,
    hash: params.hash,
    created_at: Date.now()
  };
  await getDynamoClient().send(new PutCommand({ TableName: tableName(), Item: record }));
  return record;
}

export async function updateMeta(
  userId: string,
  soundId: string,
  patch: { name?: string; emoji?: string; volume?: number }
): Promise<void> {
  const sets: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    sets.push('#name = :name');
    names['#name'] = 'name';
    values[':name'] = patch.name.trim().slice(0, 60);
  }
  if (patch.emoji !== undefined) {
    sets.push('emoji = :emoji');
    values[':emoji'] = patch.emoji.slice(0, 8);
  }
  if (patch.volume !== undefined) {
    sets.push('volume = :volume');
    values[':volume'] = Math.max(0, Math.min(1, patch.volume));
  }
  if (sets.length === 0) return;

  await getDynamoClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { user_id: userId, sound_id: soundId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values
    })
  );
}

export async function remove(userId: string, soundId: string): Promise<void> {
  await getDynamoClient().send(
    new DeleteCommand({ TableName: tableName(), Key: { user_id: userId, sound_id: soundId } })
  );
}
