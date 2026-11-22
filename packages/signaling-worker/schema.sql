-- D1 schema for the full backend migration off DynamoDB (decisions.md §0.2/§0.3) — mirrors the
-- DynamoDB tables in packages/server/src/db/*.ts, but drops the DynamoDB-specific "lock table"
-- pattern for email/name uniqueness in favor of real SQL UNIQUE constraints (D1/SQLite has them
-- natively, DynamoDB doesn't). server_owner_locks is the one lock table kept — see servers.ts's
-- doc comment for why "one owned server per user" still needs it even with UNIQUE constraints.
--
-- Applied by hand via the Cloudflare D1 MCP tool during this session, not wrangler d1 migrations
-- (no migrations/ folder yet) — this file is the record of what was run, keep it in sync by hand
-- until a real migration tool is wired up.

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_lower TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_key TEXT,
  owned_server_id TEXT,
  created_at INTEGER NOT NULL
);

-- Atomic "reservation" for the one-owned-server-per-user rule (servers.ts createOwned) — a bare
-- UPDATE ... WHERE owned_server_id IS NULL can't make a D1 batch() roll back on 0 rows affected
-- (batch only rolls back on a real SQL error), so the guard has to be a statement that actually
-- throws (a UNIQUE violation here) when the user already owns one.
CREATE TABLE server_owner_locks (
  user_id TEXT PRIMARY KEY
);

CREATE TABLE servers (
  server_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  icon_key TEXT,
  owner_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- How this server's rooms carry audio/video (MediaMode in @concord/shared): 'mesh' (P2P) or 'sfu'
  -- (Cloudflare Realtime SFU). Set only by hand in D1, never through the app or the client.
  -- Existing databases: ALTER TABLE servers ADD COLUMN media_mode TEXT NOT NULL DEFAULT 'mesh'
  --   CHECK (media_mode IN ('mesh', 'sfu'));
  media_mode TEXT NOT NULL DEFAULT 'mesh' CHECK (media_mode IN ('mesh', 'sfu'))
);

CREATE TABLE rooms (
  server_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- [2026-08-29, ALTER TABLE aplicado à mão via D1 MCP — não recriada aqui do zero] Ordem de
  -- exibição na sidebar, editável só pelo dono (PATCH /servers/:id/rooms/order). Novas salas
  -- entram no fim (roomsRepo.create computa a próxima posição livre); linhas existentes antes
  -- dessa coluna existir foram preenchidas por ordem de created_at (mesmo comportamento visual
  -- de antes, backfill de uma vez só, não uma migração repetível).
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, room_id)
);

CREATE TABLE roles (
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE authorized_users (
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  authorized_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX idx_authorized_users_user ON authorized_users(user_id);

CREATE TABLE user_sounds (
  user_id TEXT NOT NULL,
  sound_id TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  volume REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, sound_id)
);

CREATE TABLE reports (
  report_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  server_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_reports_expires ON reports(expires_at);

CREATE TABLE system_logs (
  log_id TEXT PRIMARY KEY,
  error_type TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_system_logs_expires ON system_logs(expires_at);

CREATE TABLE server_logs (
  server_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, log_id)
);
CREATE INDEX idx_server_logs_expires ON server_logs(expires_at);
