import type { DbEnv } from './context';

export interface RoomRecord {
  server_id: string;
  room_id: string;
  name: string;
  created_at: number;
}

export async function listByServer(env: DbEnv, serverId: string): Promise<RoomRecord[]> {
  const result = await env.DB.prepare('SELECT * FROM rooms WHERE server_id = ?').bind(serverId).all<RoomRecord>();
  return result.results;
}

export async function findById(env: DbEnv, serverId: string, roomId: string): Promise<RoomRecord | null> {
  const row = await env.DB.prepare('SELECT * FROM rooms WHERE server_id = ? AND room_id = ?')
    .bind(serverId, roomId)
    .first<RoomRecord>();
  return row ?? null;
}

export async function create(env: DbEnv, params: { serverId: string; name: string }): Promise<RoomRecord> {
  const record: RoomRecord = {
    server_id: params.serverId,
    room_id: crypto.randomUUID(),
    name: params.name.trim().slice(0, 60),
    created_at: Date.now()
  };
  await env.DB.prepare('INSERT INTO rooms (server_id, room_id, name, created_at) VALUES (?, ?, ?, ?)')
    .bind(record.server_id, record.room_id, record.name, record.created_at)
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
