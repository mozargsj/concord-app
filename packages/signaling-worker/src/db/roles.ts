import type { DbEnv } from './context';

interface RoleRecord {
  server_id: string;
  user_id: string;
  rank: number;
}

export async function getRank(env: DbEnv, serverId: string, userId: string): Promise<number | null> {
  const row = await env.DB.prepare('SELECT rank FROM roles WHERE server_id = ? AND user_id = ?')
    .bind(serverId, userId)
    .first<Pick<RoleRecord, 'rank'>>();
  return row?.rank ?? null;
}

export async function setRank(env: DbEnv, serverId: string, userId: string, rank: number): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO roles (server_id, user_id, rank) VALUES (?, ?, ?)')
    .bind(serverId, userId, rank)
    .run();
}
