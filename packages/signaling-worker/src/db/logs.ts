import type { DbEnv } from './context';

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

interface LogParams {
  errorType: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
}

/** Falhas de infraestrutura gerais, não ligadas a um servidor específico (decisions.md §7). */
export async function createSystemLog(env: DbEnv, params: LogParams): Promise<void> {
  const createdAt = Date.now();
  await env.DB.prepare(
    'INSERT INTO system_logs (log_id, error_type, message, stack, context, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      crypto.randomUUID(),
      params.errorType.slice(0, 200),
      params.message.slice(0, 2000),
      params.stack?.slice(0, 8000) ?? null,
      params.context ? JSON.stringify(params.context) : null,
      createdAt,
      Math.floor(createdAt / 1000) + RETENTION_SECONDS
    )
    .run();
}

/** Falhas ligadas a um servidor específico (decisions.md §7). */
export async function createServerLog(env: DbEnv, serverId: string, params: LogParams): Promise<void> {
  const timestamp = Date.now();
  await env.DB.prepare(
    'INSERT INTO server_logs (server_id, log_id, timestamp, error_type, message, stack, context, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      serverId,
      crypto.randomUUID(),
      timestamp,
      params.errorType.slice(0, 200),
      params.message.slice(0, 2000),
      params.stack?.slice(0, 8000) ?? null,
      params.context ? JSON.stringify(params.context) : null,
      Math.floor(timestamp / 1000) + RETENTION_SECONDS
    )
    .run();
}

/** Run on a schedule (see index.ts's `scheduled` handler) — D1 has no native TTL like DynamoDB. */
export async function deleteExpired(env: DbEnv, nowSeconds: number): Promise<number> {
  const [system, server] = await env.DB.batch([
    env.DB.prepare('DELETE FROM system_logs WHERE expires_at < ?').bind(nowSeconds),
    env.DB.prepare('DELETE FROM server_logs WHERE expires_at < ?').bind(nowSeconds)
  ]);
  return (system.meta.changes ?? 0) + (server.meta.changes ?? 0);
}
