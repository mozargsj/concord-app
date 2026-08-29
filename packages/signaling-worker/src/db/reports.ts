import type { DbEnv } from './context';

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

export async function create(
  env: DbEnv,
  params: { userId: string; type: 'bug' | 'suggestion'; message: string; serverId?: string }
): Promise<void> {
  const createdAt = Date.now();
  await env.DB.prepare(
    'INSERT INTO reports (report_id, user_id, type, message, server_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      crypto.randomUUID(),
      params.userId,
      params.type,
      params.message.slice(0, 2000),
      params.serverId ?? null,
      createdAt,
      Math.floor(createdAt / 1000) + RETENTION_SECONDS
    )
    .run();
}

/** Run on a schedule (see index.ts's `scheduled` handler) — D1 has no native TTL like DynamoDB,
 * so expiry is a manual sweep instead. */
export async function deleteExpired(env: DbEnv, nowSeconds: number): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM reports WHERE expires_at < ?').bind(nowSeconds).run();
  return result.meta.changes ?? 0;
}
