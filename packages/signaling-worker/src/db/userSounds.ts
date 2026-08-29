import type { DbEnv } from './context';

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

export async function listByUser(env: DbEnv, userId: string): Promise<UserSoundRecord[]> {
  const result = await env.DB.prepare('SELECT * FROM user_sounds WHERE user_id = ?').bind(userId).all<UserSoundRecord>();
  return result.results;
}

export async function create(
  env: DbEnv,
  params: { userId: string; soundId: string; name: string; emoji: string; volume: number; durationMs: number; hash: string }
): Promise<UserSoundRecord> {
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
  await env.DB.prepare(
    'INSERT INTO user_sounds (user_id, sound_id, name, emoji, volume, duration_ms, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(record.user_id, record.sound_id, record.name, record.emoji, record.volume, record.duration_ms, record.hash, record.created_at)
    .run();
  return record;
}

export async function updateMeta(
  env: DbEnv,
  userId: string,
  soundId: string,
  patch: { name?: string; emoji?: string; volume?: number }
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name.trim().slice(0, 60));
  }
  if (patch.emoji !== undefined) {
    sets.push('emoji = ?');
    values.push(patch.emoji.slice(0, 8));
  }
  if (patch.volume !== undefined) {
    sets.push('volume = ?');
    values.push(Math.max(0, Math.min(1, patch.volume)));
  }
  if (sets.length === 0) return;

  values.push(userId, soundId);
  await env.DB.prepare(`UPDATE user_sounds SET ${sets.join(', ')} WHERE user_id = ? AND sound_id = ?`)
    .bind(...values)
    .run();
}

export async function remove(env: DbEnv, userId: string, soundId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM user_sounds WHERE user_id = ? AND sound_id = ?').bind(userId, soundId).run();
}
