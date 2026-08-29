import type { DbEnv } from './context';

export async function authorize(env: DbEnv, serverId: string, userId: string): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO authorized_users (server_id, user_id, authorized_at) VALUES (?, ?, ?)')
    .bind(serverId, userId, Date.now())
    .run();
}

/** Every server this user is a member of (owner included — owners are authorized at server-creation time too). */
export async function listServerIdsForUser(env: DbEnv, userId: string): Promise<string[]> {
  const result = await env.DB.prepare('SELECT server_id FROM authorized_users WHERE user_id = ?')
    .bind(userId)
    .all<{ server_id: string }>();
  return result.results.map((row) => row.server_id);
}
