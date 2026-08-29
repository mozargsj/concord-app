import type { DbEnv } from './context';

export interface UserRecord {
  user_id: string;
  email: string;
  email_lower: string;
  display_name: string;
  avatar_key: string | null;
  owned_server_id: string | null;
  created_at: number;
}

export class UserCreateConflictError extends Error {
  constructor(public reason: 'email-taken') {
    super(reason);
  }
}

/** D1/SQLite reports a constraint violation as a thrown Error with the constraint name in its
 * message (e.g. "UNIQUE constraint failed: users.email_lower") — no structured error code like
 * DynamoDB's CancellationReasons, so this is the only way to distinguish "this email is taken"
 * from any other failure. */
function isUniqueViolation(error: unknown, column: string): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed') && error.message.includes(column);
}

export async function findByEmail(env: DbEnv, email: string): Promise<UserRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM users WHERE email_lower = ?')
    .bind(email.trim().toLowerCase())
    .first<UserRecord>();
  return row ?? null;
}

export async function findById(env: DbEnv, id: string): Promise<UserRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(id).first<UserRecord>();
  return row ?? null;
}

export async function create(env: DbEnv, params: { email: string; displayName: string }): Promise<UserRecord> {
  const record: UserRecord = {
    user_id: crypto.randomUUID(),
    email: params.email.trim(),
    email_lower: params.email.trim().toLowerCase(),
    display_name: params.displayName.trim().slice(0, 60),
    avatar_key: null,
    owned_server_id: null,
    created_at: Date.now()
  };
  try {
    await env.DB.prepare(
      'INSERT INTO users (user_id, email, email_lower, display_name, avatar_key, owned_server_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(record.user_id, record.email, record.email_lower, record.display_name, record.avatar_key, record.owned_server_id, record.created_at)
      .run();
  } catch (error) {
    if (isUniqueViolation(error, 'users.email_lower')) throw new UserCreateConflictError('email-taken');
    throw error;
  }
  return record;
}

export async function updateProfile(
  env: DbEnv,
  id: string,
  patch: { displayName?: string; avatarKey?: string }
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    values.push(patch.displayName.trim().slice(0, 60));
  }
  if (patch.avatarKey !== undefined) {
    sets.push('avatar_key = ?');
    values.push(patch.avatarKey);
  }
  if (sets.length === 0) return;

  values.push(id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`)
    .bind(...values)
    .run();
}
