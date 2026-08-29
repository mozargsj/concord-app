import type { DbEnv } from './context';

export interface RoomRecord {
  server_id: string;
  room_id: string;
  name: string;
  created_at: number;
  position: number;
}

export async function listByServer(env: DbEnv, serverId: string): Promise<RoomRecord[]> {
  const result = await env.DB.prepare('SELECT * FROM rooms WHERE server_id = ? ORDER BY position ASC, created_at ASC')
    .bind(serverId)
    .all<RoomRecord>();
  return result.results;
}

export async function findById(env: DbEnv, serverId: string, roomId: string): Promise<RoomRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM rooms WHERE server_id = ? AND room_id = ?')
    .bind(serverId, roomId)
    .first<RoomRecord>();
  return row ?? null;
}

export async function create(env: DbEnv, params: { serverId: string; name: string }): Promise<RoomRecord> {
  // New rooms always append at the end — same visual behavior as before position existed
  // (creation order), just explicit now instead of relying on SQLite's incidental row order.
  const { count } = (await env.DB.prepare('SELECT COUNT(*) AS count FROM rooms WHERE server_id = ?')
    .bind(params.serverId)
    .first<{ count: number }>()) ?? { count: 0 };

  const record: RoomRecord = {
    server_id: params.serverId,
    room_id: crypto.randomUUID(),
    name: params.name.trim().slice(0, 60),
    created_at: Date.now(),
    position: count
  };
  await env.DB.prepare('INSERT INTO rooms (server_id, room_id, name, created_at, position) VALUES (?, ?, ?, ?, ?)')
    .bind(record.server_id, record.room_id, record.name, record.created_at, record.position)
    .run();
  return record;
}

export async function updateName(env: DbEnv, serverId: string, roomId: string, name: string): Promise<void> {
  await env.DB.prepare('UPDATE rooms SET name = ? WHERE server_id = ? AND room_id = ?')
    .bind(name.trim().slice(0, 60), serverId, roomId)
    .run();
}

export async function remove(env: DbEnv, serverId: string, roomId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM rooms WHERE server_id = ? AND room_id = ?').bind(serverId, roomId).run();
}

/** [2026-08-29, pedido do Mozar — reordenar salas, dono só] `roomIds` é a nova ordem completa —
 * cada posição vira o índice dela na lista. O caller (rest.ts) já garante que todo id pertence a
 * este servidor antes de chamar isto; um batch só, mesma técnica atômica já usada em
 * servers.ts/createOwned. */
export async function setOrder(env: DbEnv, serverId: string, roomIds: string[]): Promise<void> {
  await env.DB.batch(
    roomIds.map((roomId, index) =>
      env.DB.prepare('UPDATE rooms SET position = ? WHERE server_id = ? AND room_id = ?').bind(index, serverId, roomId)
    )
  );
}
