import type { DbEnv } from './context';

export interface ServerRecord {
  server_id: string;
  name: string;
  name_lower: string;
  icon_key: string | null;
  owner_user_id: string;
  created_at: number;
}

export class ServerCreateConflictError extends Error {
  constructor(public reason: 'name-taken' | 'already-owns-server') {
    super(reason);
  }
}

function isUniqueViolation(error: unknown, column: string): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed') && error.message.includes(column);
}

export async function findByNameLower(env: DbEnv, nameLower: string): Promise<ServerRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM servers WHERE name_lower = ?').bind(nameLower).first<ServerRecord>();
  return row ?? null;
}

export async function findById(env: DbEnv, id: string): Promise<ServerRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM servers WHERE server_id = ?').bind(id).first<ServerRecord>();
  return row ?? null;
}

/**
 * Atomic via D1's batch() (a real SQL transaction — see schema.sql's comment on
 * server_owner_locks for why a plain guarded UPDATE isn't enough on its own): reserving the
 * owner's "only one server" lock, inserting the server row, and setting owned_server_id all
 * commit together or not at all. If the owner already has a lock row (already owns a server) or
 * the name is taken (name_lower UNIQUE), the whole batch fails and nothing is written — mirrors
 * packages/server/src/db/serversRepo.ts's createOwned, minus the DynamoDB-specific lock-table
 * dance for name uniqueness (a real UNIQUE constraint does that part here).
 */
export async function createOwned(
  env: DbEnv,
  params: { name: string; ownerUserId: string }
): Promise<ServerRecord> {
  const trimmed = params.name.trim();
  const record: ServerRecord = {
    server_id: crypto.randomUUID(),
    name: trimmed,
    name_lower: trimmed.toLowerCase(),
    // [2026-08-29] Sempre null agora — /uploads/presign (única forma de existir um icon_key de
    // verdade) foi removido, achado de segurança da auditoria (endpoint sem rate limit/tamanho
    // máximo, e confirmado morto: ícone de servidor é 100% P2P/cache local desde antes disso).
    icon_key: null,
    owner_user_id: params.ownerUserId,
    created_at: Date.now()
  };

  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO server_owner_locks (user_id) VALUES (?)').bind(params.ownerUserId),
      env.DB.prepare(
        'INSERT INTO servers (server_id, name, name_lower, icon_key, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(record.server_id, record.name, record.name_lower, record.icon_key, record.owner_user_id, record.created_at),
      env.DB.prepare('UPDATE users SET owned_server_id = ? WHERE user_id = ?').bind(record.server_id, params.ownerUserId)
    ]);
  } catch (error) {
    if (isUniqueViolation(error, 'server_owner_locks')) throw new ServerCreateConflictError('already-owns-server');
    if (isUniqueViolation(error, 'servers.name_lower')) throw new ServerCreateConflictError('name-taken');
    throw error;
  }

  return record;
}

export async function updateName(env: DbEnv, serverId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  await env.DB.prepare('UPDATE servers SET name = ?, name_lower = ? WHERE server_id = ?')
    .bind(trimmed, trimmed.toLowerCase(), serverId)
    .run();
}

/**
 * No FK CASCADE in this schema (schema.sql, D1/SQLite) — every table that references a server has
 * to be cleared by hand, in one batch() so it's all-or-nothing like createOwned above. Doesn't
 * touch rooms/user_sounds/reports/logs tables that reference OTHER servers, obviously — only rows
 * scoped to this serverId. Room DOs for this server aren't torn down here (out of scope for a D1
 * transaction) — they just become unreachable via REST membership checks going forward; any call
 * still active in one keeps running until it ends naturally.
 */
export async function deleteServer(env: DbEnv, serverId: string, ownerUserId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rooms WHERE server_id = ?').bind(serverId),
    env.DB.prepare('DELETE FROM roles WHERE server_id = ?').bind(serverId),
    env.DB.prepare('DELETE FROM authorized_users WHERE server_id = ?').bind(serverId),
    env.DB.prepare('DELETE FROM server_owner_locks WHERE user_id = ?').bind(ownerUserId),
    env.DB.prepare('UPDATE users SET owned_server_id = NULL WHERE user_id = ?').bind(ownerUserId),
    env.DB.prepare('DELETE FROM servers WHERE server_id = ?').bind(serverId)
  ]);
}
