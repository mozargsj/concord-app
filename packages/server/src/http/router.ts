import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  ApiErrorResponse,
  ClientErrorReportRequest,
  CreateInviteResponse,
  CreateReportRequest,
  CreateRoomRequest,
  CreateServerRequest,
  CreateServerResponse,
  CreateUserSoundRequest,
  JoinServerRequest,
  LoginRequest,
  LoginResponse,
  PresignUploadRequest,
  PresignUploadResponse,
  RoomListResponse,
  RoomResponse,
  RoomSummary,
  ServerDetailsResponse,
  ServerListResponse,
  ServerSummary,
  UpdateProfileRequest,
  UpdateRoomRequest,
  UpdateServerRequest,
  UpdateUserSoundRequest,
  UserProfile,
  UserSoundListResponse,
  UserSoundResponse,
  UserSoundSummary
} from '@concord/shared';
import { Role, hasAtLeastRole } from '@concord/shared';
import * as usersRepo from '../db/usersRepo.js';
import * as serversRepo from '../db/serversRepo.js';
import * as roomsRepo from '../db/roomsRepo.js';
import * as rolesRepo from '../db/rolesRepo.js';
import * as authorizedUsersRepo from '../db/authorizedUsersRepo.js';
import * as userSoundsRepo from '../db/userSoundsRepo.js';
import * as reportsRepo from '../db/reportsRepo.js';
import { createPresignedGetUrl, createPresignedUploadUrl, putObject } from '../aws/s3Client.js';
import { signSessionToken, verifySessionToken } from '../auth/session.js';
import { signInviteToken, verifyInviteToken } from '../auth/invite.js';
import { logError } from '../logging/errorLog.js';
import { env } from '../config/env.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

// Static file host for auto-update artifacts (latest.yml, the NSIS installer, .blockmap) —
// electron-updater's "generic" provider just does plain HTTPS GET requests. Reuses this
// server's own already-trusted domain instead of a new public S3 bucket (concord-server-icons
// is deliberately fully private). Files are uploaded to this directory manually/via SSM at
// release time — no publish automation yet.
const UPDATES_DIR = resolve(process.env.UPDATES_DIR ?? join(process.cwd(), 'updates'));

function contentTypeForUpdateFile(filePath: string): string {
  if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) return 'application/x-yaml';
  return 'application/octet-stream';
}

// Cloudflare proxies this domain (same as production, decisions.md §2) and caches responses —
// including 404s — by default. Discovered locally: a stale-cached 404 from hitting this route
// before a release finished uploading kept blocking a real, already-published update artifact
// for hours. no-store on every response here (hit or miss) keeps the edge from ever caching a
// transient state for this endpoint.
function handleServeUpdateFile(req: IncomingMessage, res: ServerResponse, segments: string[]): void {
  if (req.method !== 'GET' || segments.length < 2) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'not-found' } satisfies ApiErrorResponse));
    return;
  }

  // [Achado de segurança] filePath.startsWith(UPDATES_DIR) alone (no trailing separator) also
  // matches a sibling path that merely shares the same string prefix — e.g. UPDATES_DIR
  // "/opt/concord/updates" would wrongly accept "/opt/concord/updates-backup/anything". Requiring
  // the separator (or an exact match, for the directory itself) makes this a real containment
  // check instead of a string-prefix coincidence.
  const filePath = resolve(join(UPDATES_DIR, ...segments.slice(1)));
  const isInsideUpdatesDir = filePath === UPDATES_DIR || filePath.startsWith(UPDATES_DIR + sep);
  if (!isInsideUpdatesDir || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'not-found' } satisfies ApiErrorResponse));
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentTypeForUpdateFile(filePath),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS
  });
  createReadStream(filePath).pipe(res);
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error } satisfies ApiErrorResponse);
}

// [Achado de segurança] Sem isso, readJsonBody acumulava o corpo inteiro em memória antes de
// validar qualquer coisa — inclusive em rotas públicas sem sessão (POST /logs/client-error), o
// que deixava qualquer um mandar um corpo gigante pra consumir memória do processo. 1MiB é bem
// acima de qualquer payload real deste app (avatar/ícone/som vão direto pro S3 via URL presignada,
// nunca por aqui — o corpo JSON mais pesado de verdade é um stack trace de erro).
const MAX_JSON_BODY_BYTES = 1024 * 1024;

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      req.destroy();
      return null;
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Reads and verifies the `Authorization: Bearer <token>` header. Sends 401 and returns null on failure. */
async function requireSession(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const userId = token ? await verifySessionToken(token) : null;
  if (!userId) {
    sendError(res, 401, 'unauthorized');
    return null;
  }
  return userId;
}

/** Owner is Role.Dono implicitly (not necessarily mirrored in concord_roles for pre-existing data); everyone else's rank comes from concord_roles. null = not a member at all. */
async function getEffectiveRank(serverId: string, userId: string, ownerUserId: string): Promise<Role | null> {
  if (userId === ownerUserId) return Role.Dono;
  const rank = await rolesRepo.getRank(serverId, userId);
  return (rank as Role | null) ?? null;
}

/** Combines requireSession with a minimum-rank check for a specific server. Sends 401/403 and returns null on failure. */
async function requireRank(
  req: IncomingMessage,
  res: ServerResponse,
  server: serversRepo.ServerRecord,
  minRank: Role
): Promise<string | null> {
  const userId = await requireSession(req, res);
  if (!userId) return null;
  const rank = await getEffectiveRank(server.server_id, userId, server.owner_user_id);
  if (rank === null || !hasAtLeastRole(rank, minRank)) {
    sendError(res, 403, 'forbidden');
    return null;
  }
  return userId;
}

async function toUserProfile(record: usersRepo.UserRecord): Promise<UserProfile> {
  return {
    id: record.user_id,
    email: record.email,
    displayName: record.display_name,
    avatarUrl: record.avatar_key ? await createPresignedGetUrl(record.avatar_key) : null,
    ownedServerId: record.owned_server_id
  };
}

async function toServerSummary(record: serversRepo.ServerRecord): Promise<ServerSummary> {
  return {
    id: record.server_id,
    name: record.name,
    iconUrl: record.icon_key ? await createPresignedGetUrl(record.icon_key) : null,
    ownerUserId: record.owner_user_id
  };
}

function toUserSoundSummary(record: userSoundsRepo.UserSoundRecord): UserSoundSummary {
  return {
    id: record.sound_id,
    name: record.name,
    emoji: record.emoji,
    volume: record.volume,
    durationMs: record.duration_ms,
    hash: record.hash
  };
}

function toRoomSummary(record: roomsRepo.RoomRecord): RoomSummary {
  // Real-time member count is a signaling-server (WS) concern, not tracked in DynamoDB.
  return { id: record.room_id, serverId: record.server_id, name: record.name, memberCount: 0, maxMembers: 10 };
}

/** Best-effort: downloads the Google profile picture and stores it under the new user's own avatar key. */
async function importAvatarFromUrl(userId: string, imageUrl: string): Promise<string | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const bytes = new Uint8Array(await response.arrayBuffer());
    const key = `avatars/${userId}-${Date.now()}`;
    await putObject(key, bytes, contentType);
    return key;
  } catch {
    return null;
  }
}

/** Hand-rolled router — no framework, matches the project's minimal-dependency style (plain `ws` over Socket.io). */
export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');
  // url.pathname keeps percent-encoding as-is (e.g. a space in an update artifact's filename
  // arrives as %20) — decode once here so every route/handler gets the real segment value.
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
    // Pure liveness probe — no auth, no DB — so the client can tell "server unreachable" apart
    // from "server up but this request failed" before ever trying to log in.
    if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (segments[0] === 'updates') {
      handleServeUpdateFile(req, res, segments);
      return;
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'users') {
      await handleLogin(req, res);
      return;
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'users' && segments[1] === 'me') {
      await handleGetMe(req, res);
      return;
    }
    if (method === 'PATCH' && segments.length === 2 && segments[0] === 'users' && segments[1] === 'me') {
      await handleUpdateMe(req, res);
      return;
    }
    if (
      method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'users' &&
      segments[1] === 'me' &&
      segments[2] === 'servers'
    ) {
      await handleListMyServers(req, res);
      return;
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'servers') {
      await handleCreateServer(req, res);
      return;
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'servers' && segments[1] === 'join') {
      await handleJoinServer(req, res);
      return;
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'servers') {
      await handleGetServer(req, res, segments[1]);
      return;
    }
    if (method === 'PATCH' && segments.length === 2 && segments[0] === 'servers') {
      await handleUpdateServer(req, res, segments[1]);
      return;
    }
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'servers' &&
      segments[2] === 'invites'
    ) {
      await handleCreateInvite(req, res, segments[1]);
      return;
    }
    if (method === 'GET' && segments.length === 3 && segments[0] === 'servers' && segments[2] === 'rooms') {
      await handleListRooms(req, res, segments[1]);
      return;
    }
    if (method === 'POST' && segments.length === 3 && segments[0] === 'servers' && segments[2] === 'rooms') {
      await handleCreateRoom(req, res, segments[1]);
      return;
    }
    if (method === 'PATCH' && segments.length === 4 && segments[0] === 'servers' && segments[2] === 'rooms') {
      await handleUpdateRoom(req, res, segments[1], segments[3]);
      return;
    }
    if (method === 'DELETE' && segments.length === 4 && segments[0] === 'servers' && segments[2] === 'rooms') {
      await handleDeleteRoom(req, res, segments[1], segments[3]);
      return;
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'uploads' && segments[1] === 'presign') {
      await handlePresignUpload(req, res);
      return;
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'webrtc' && segments[1] === 'turn-credentials') {
      await handleGetTurnCredentials(req, res);
      return;
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'logs' && segments[1] === 'client-error') {
      await handleClientErrorReport(req, res);
      return;
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'reports') {
      await handleCreateReport(req, res);
      return;
    }
    if (
      method === 'GET' &&
      segments.length === 3 &&
      segments[0] === 'users' &&
      segments[1] === 'me' &&
      segments[2] === 'sounds'
    ) {
      await handleListMySounds(req, res);
      return;
    }
    if (
      method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'users' &&
      segments[1] === 'me' &&
      segments[2] === 'sounds'
    ) {
      await handleCreateSound(req, res);
      return;
    }
    if (
      method === 'PATCH' &&
      segments.length === 4 &&
      segments[0] === 'users' &&
      segments[1] === 'me' &&
      segments[2] === 'sounds'
    ) {
      await handleUpdateSound(req, res, segments[3]);
      return;
    }
    if (
      method === 'DELETE' &&
      segments.length === 4 &&
      segments[0] === 'users' &&
      segments[1] === 'me' &&
      segments[2] === 'sounds'
    ) {
      await handleDeleteSound(req, res, segments[3]);
      return;
    }
    sendError(res, 404, 'not-found');
  } catch (error) {
    // segments/method already parsed above — best-effort serverId extraction from routes shaped
    // /servers/:id/... covers the common case without needing every handler to catch locally.
    const serverId = segments[0] === 'servers' && segments.length > 1 ? segments[1] : undefined;
    await logError(error, { source: 'http', route: `${method} ${url.pathname}`, serverId });
    sendError(res, 500, 'internal-error');
  }
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<LoginRequest>(req);
  const email = body?.email?.trim();
  const displayName = body?.displayName?.trim();
  if (!email) return sendError(res, 400, 'email-required');
  if (!displayName) return sendError(res, 400, 'display-name-required');

  let record = await usersRepo.findByEmail(email);
  const isNewUser = !record;
  if (!record) {
    try {
      record = await usersRepo.create({ email, displayName });
    } catch (error) {
      if (!(error instanceof usersRepo.UserCreateConflictError)) throw error;
      // Lost a race against a concurrent first login for the same email (see usersRepo.create's
      // own comment) — the winner's row already exists now, so this request just logs into that
      // account instead of failing. isNewUser stays true below, so the avatar-import step can
      // still run redundantly against the now-existing record — harmless, just a wasted fetch in
      // an already-rare race.
      record = await usersRepo.findByEmail(email);
      if (!record) throw error;
    }
  }

  if (isNewUser && body?.avatarImageUrl) {
    const key = await importAvatarFromUrl(record.user_id, body.avatarImageUrl);
    if (key) {
      await usersRepo.updateProfile(record.user_id, { avatarKey: key });
      record = (await usersRepo.findById(record.user_id)) ?? record;
    }
  }

  const sessionToken = await signSessionToken(record.user_id);
  const response: LoginResponse = { user: await toUserProfile(record), sessionToken };
  sendJson(res, 200, response);
}

async function handleGetMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const record = await usersRepo.findById(userId);
  if (!record) return sendError(res, 404, 'user-not-found');
  sendJson(res, 200, { user: await toUserProfile(record) });
}

async function handleUpdateMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const existing = await usersRepo.findById(userId);
  if (!existing) return sendError(res, 404, 'user-not-found');

  const body = await readJsonBody<UpdateProfileRequest>(req);
  const avatarKey = body?.avatarKey || undefined;
  // [Achado de segurança] handlePresignUpload only ever hands out a key under `avatars/${userId}-
  // ...` — without re-checking that prefix here, this endpoint would happily bind ANY key the
  // client sends (including one belonging to someone else, if guessed/known) to this user's
  // profile, and toUserProfile would then hand back a presigned GET URL for it.
  if (avatarKey && !avatarKey.startsWith(`avatars/${userId}-`)) return sendError(res, 403, 'forbidden');
  await usersRepo.updateProfile(userId, {
    displayName: body?.displayName?.trim() || undefined,
    avatarKey
  });

  const updated = await usersRepo.findById(userId);
  sendJson(res, 200, { user: await toUserProfile(updated!) });
}

async function handleListMyServers(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const serverIds = await authorizedUsersRepo.listServerIdsForUser(userId);
  const records = await Promise.all(serverIds.map((id) => serversRepo.findById(id)));
  const servers = await Promise.all(
    records.filter((record): record is serversRepo.ServerRecord => record !== null).map(toServerSummary)
  );
  const response: ServerListResponse = { servers };
  sendJson(res, 200, response);
}

async function handleCreateServer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const body = await readJsonBody<CreateServerRequest>(req);
  const name = body?.name?.trim();
  if (!name) return sendError(res, 400, 'name-required');
  const iconKey = body?.iconKey ?? null;
  // Same rationale as handleUpdateMe's avatarKey check — handlePresignUpload only ever hands out
  // a server-icon key under `servers/${userId}-...` (the creator's own id, since the server
  // doesn't exist yet at upload time), so anything else isn't a key this request legitimately owns.
  if (iconKey && !iconKey.startsWith(`servers/${userId}-`)) return sendError(res, 403, 'forbidden');

  const owner = await usersRepo.findById(userId);
  if (!owner) return sendError(res, 404, 'user-not-found');
  // Fast pre-checks for the common case's error messages — the real guard against a concurrent
  // double-submit is the transaction inside serversRepo.createOwned below.
  if (owner.owned_server_id) return sendError(res, 409, 'already-owns-server');
  const existing = await serversRepo.findByNameLower(name.toLowerCase());
  if (existing) return sendError(res, 409, 'name-taken');

  let record: serversRepo.ServerRecord;
  try {
    record = await serversRepo.createOwned({ name, iconKey, ownerUserId: userId });
  } catch (error) {
    if (error instanceof serversRepo.ServerCreateConflictError) return sendError(res, 409, error.reason);
    throw error;
  }
  await authorizedUsersRepo.authorize(record.server_id, userId);
  await rolesRepo.setRank(record.server_id, userId, Role.Dono);

  const response: CreateServerResponse = { server: await toServerSummary(record) };
  sendJson(res, 201, response);
}

async function handleJoinServer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const body = await readJsonBody<JoinServerRequest>(req);
  const code = body?.code?.trim();
  if (!code) return sendError(res, 400, 'code-required');

  const serverId = await verifyInviteToken(code);
  if (!serverId) return sendError(res, 400, 'invalid-code');

  const server = await serversRepo.findById(serverId);
  if (!server) return sendError(res, 404, 'server-not-found');

  await authorizedUsersRepo.authorize(serverId, userId);
  const existingRank = await rolesRepo.getRank(serverId, userId);
  if (existingRank === null && server.owner_user_id !== userId) {
    await rolesRepo.setRank(serverId, userId, Role.Usuario);
  }

  const response: CreateServerResponse = { server: await toServerSummary(server) };
  sendJson(res, 200, response);
}

async function handleGetServer(req: IncomingMessage, res: ServerResponse, serverId: string): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const record = await serversRepo.findById(serverId);
  if (!record) return sendError(res, 404, 'server-not-found');

  const myRole = await getEffectiveRank(serverId, userId, record.owner_user_id);
  if (myRole === null) return sendError(res, 403, 'forbidden');

  const response: ServerDetailsResponse = { server: await toServerSummary(record), myRole };
  sendJson(res, 200, response);
}

async function handleUpdateServer(req: IncomingMessage, res: ServerResponse, serverId: string): Promise<void> {
  const server = await serversRepo.findById(serverId);
  if (!server) return sendError(res, 404, 'server-not-found');
  // Rename is owner-only — same rank as creating/deleting a room (decisions.md §6), no separate
  // "admin can rename the server" allowance was asked for.
  const userId = await requireRank(req, res, server, Role.Dono);
  if (!userId) return;

  const body = await readJsonBody<UpdateServerRequest>(req);
  const name = body?.name?.trim();
  if (!name) return sendError(res, 400, 'name-required');

  if (name.toLowerCase() !== server.name_lower) {
    const existing = await serversRepo.findByNameLower(name.toLowerCase());
    if (existing && existing.server_id !== serverId) return sendError(res, 409, 'name-taken');
  }

  await serversRepo.updateName(serverId, name);
  const updated = await serversRepo.findById(serverId);
  const response: CreateServerResponse = { server: await toServerSummary(updated!) };
  sendJson(res, 200, response);
}

async function handleCreateInvite(req: IncomingMessage, res: ServerResponse, serverId: string): Promise<void> {
  const server = await serversRepo.findById(serverId);
  if (!server) return sendError(res, 404, 'server-not-found');
  const userId = await requireRank(req, res, server, Role.Admin);
  if (!userId) return;

  const code = await signInviteToken(serverId);
  const response: CreateInviteResponse = { code };
  sendJson(res, 200, response);
}

async function handleListRooms(req: IncomingMessage, res: ServerResponse, serverId: string): Promise<void> {
  const server = await serversRepo.findById(serverId);
  if (!server) return sendError(res, 404, 'server-not-found');
  const userId = await requireRank(req, res, server, Role.Usuario);
  if (!userId) return;

  const records = await roomsRepo.listByServer(serverId);
  const response: RoomListResponse = { rooms: records.map(toRoomSummary) };
  sendJson(res, 200, response);
}

async function handleCreateRoom(req: IncomingMessage, res: ServerResponse, serverId: string): Promise<void> {
  const server = await serversRepo.findById(serverId);
  if (!server) return sendError(res, 404, 'server-not-found');
  const userId = await requireRank(req, res, server, Role.Dono);
  if (!userId) return;

  const body = await readJsonBody<CreateRoomRequest>(req);
  const name = body?.name?.trim();
  if (!name) return sendError(res, 400, 'name-required');

  const record = await roomsRepo.create({ serverId, name });
  const response: RoomResponse = { room: toRoomSummary(record) };
  sendJson(res, 201, response);
}

async function handleUpdateRoom(
  req: IncomingMessage,
  res: ServerResponse,
  serverId: string,
  roomId: string
): Promise<void> {
  const server = await serversRepo.findById(serverId);
  if (!server) return sendError(res, 404, 'server-not-found');
  const userId = await requireRank(req, res, server, Role.Admin);
  if (!userId) return;

  const existing = await roomsRepo.findById(serverId, roomId);
  if (!existing) return sendError(res, 404, 'room-not-found');

  const body = await readJsonBody<UpdateRoomRequest>(req);
  const name = body?.name?.trim();
  if (!name) return sendError(res, 400, 'name-required');

  await roomsRepo.updateName(serverId, roomId, name);
  const updated = await roomsRepo.findById(serverId, roomId);
  const response: RoomResponse = { room: toRoomSummary(updated!) };
  sendJson(res, 200, response);
}

async function handleDeleteRoom(
  req: IncomingMessage,
  res: ServerResponse,
  serverId: string,
  roomId: string
): Promise<void> {
  const server = await serversRepo.findById(serverId);
  if (!server) return sendError(res, 404, 'server-not-found');
  const userId = await requireRank(req, res, server, Role.Dono);
  if (!userId) return;

  await roomsRepo.remove(serverId, roomId);
  sendJson(res, 200, {});
}

async function handleListMySounds(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const records = await userSoundsRepo.listByUser(userId);
  const response: UserSoundListResponse = { sounds: records.map(toUserSoundSummary) };
  sendJson(res, 200, response);
}

async function handleCreateSound(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const body = await readJsonBody<CreateUserSoundRequest>(req);
  const id = body?.id?.trim();
  const name = body?.name?.trim();
  if (!id) return sendError(res, 400, 'id-required');
  if (!name) return sendError(res, 400, 'name-required');
  if (typeof body?.durationMs !== 'number' || typeof body?.volume !== 'number' || !body?.hash) {
    return sendError(res, 400, 'invalid-request');
  }

  const record = await userSoundsRepo.create({
    userId,
    soundId: id,
    name,
    emoji: body.emoji ?? '',
    volume: body.volume,
    durationMs: body.durationMs,
    hash: body.hash
  });
  const response: UserSoundResponse = { sound: toUserSoundSummary(record) };
  sendJson(res, 201, response);
}

async function handleUpdateSound(req: IncomingMessage, res: ServerResponse, soundId: string): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const body = await readJsonBody<UpdateUserSoundRequest>(req);
  await userSoundsRepo.updateMeta(userId, soundId, {
    name: body?.name?.trim() || undefined,
    emoji: body?.emoji,
    volume: body?.volume
  });
  sendJson(res, 200, {});
}

async function handleDeleteSound(req: IncomingMessage, res: ServerResponse, soundId: string): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  await userSoundsRepo.remove(userId, soundId);
  sendJson(res, 200, {});
}

/** Public (session optional) — a client error can happen before login exists too. Whatever
 * userId/serverId/roomId the client already knows travels in `context`, same shape logError
 * already accepts. */
async function handleClientErrorReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const userId = token ? await verifySessionToken(token) : null;

  const body = await readJsonBody<ClientErrorReportRequest>(req);
  if (!body?.errorType || !body?.message) return sendError(res, 400, 'invalid-request');

  const context = body.context && typeof body.context === 'object' ? body.context : undefined;
  const serverId = typeof context?.serverId === 'string' ? context.serverId : undefined;

  // Preserves the client's own error name/stack instead of a fresh one pointing at this handler —
  // logError derives errorType/stack from the Error object it's given.
  const clientError = new Error(body.message);
  clientError.name = body.errorType;
  if (body.stack) clientError.stack = body.stack;

  await logError(clientError, {
    source: 'client',
    route: body.errorType,
    userId: userId ?? undefined,
    serverId,
    roomId: typeof context?.roomId === 'string' ? context.roomId : undefined,
    // [Diagnóstico, adicionado 2026-08-27] webrtcMesh.ts's onConnectionError sends both on every
    // call (see useRoomConnection.ts's wiring) — previously dropped here despite arriving, losing
    // exactly the fields needed to tell which peer/event-kind a log line was about.
    peerId: typeof context?.peerId === 'string' ? context.peerId : undefined,
    kind: typeof context?.kind === 'string' ? context.kind : undefined
  });

  sendJson(res, 200, {});
}

/** Bug/melhoria reportado pelo usuário via UI (decisions.md §7) — distinto do client-error acima
 * (captura automática). Session required: this is always someone telling us something, not an
 * anonymous crash. */
async function handleCreateReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const body = await readJsonBody<CreateReportRequest>(req);
  const message = body?.message?.trim();
  if (!body?.type || (body.type !== 'bug' && body.type !== 'suggestion') || !message) {
    return sendError(res, 400, 'invalid-request');
  }

  await reportsRepo.create({ userId, type: body.type, message, serverId: body.serverId });
  sendJson(res, 200, {});
}

async function handlePresignUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const body = await readJsonBody<PresignUploadRequest>(req);
  if (!body?.kind || !body.id || !body.contentType) return sendError(res, 400, 'invalid-request');
  // The uploaded key is always namespaced under the requester's own id — for a server icon this
  // is the creator's user id too (the server doesn't exist yet at upload time), so the same check
  // covers both kinds without needing to know a not-yet-created server_id.
  if (body.id !== userId) return sendError(res, 403, 'forbidden');

  const prefix = body.kind === 'user-avatar' ? 'avatars' : 'servers';
  const key = `${prefix}/${body.id}-${Date.now()}`;
  const uploadUrl = await createPresignedUploadUrl(key, body.contentType);
  const response: PresignUploadResponse = { uploadUrl, key };
  sendJson(res, 200, response);
}

// 4h — comfortably longer than any real call session, short enough that a leaked credential
// (it's handed to the renderer, same trust level as everything else client-side) stops working
// on its own well before a full day passes.
const TURN_CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;

/**
 * [Teste de conectividade 2026-08-27] Minta credenciais TURN de curta duração via Cloudflare
 * Realtime, sob demanda, autenticado — nunca expõe env.turnApiToken (o secret permanente) pro
 * client, só o par username/credential de vida curta que a própria Cloudflare gera. Existe
 * especificamente pra descartar (ou confirmar) falta de TURN como causa da falha total de
 * conectividade P2P observada com testers reais; se TURN_KEY_ID/TURN_API_TOKEN não estiverem
 * configurados, responde com iceServers vazio e o client cai de volta pro STUN-only de sempre.
 */
async function handleGetTurnCredentials(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  if (!env.turnKeyId || !env.turnApiToken) {
    sendJson(res, 200, { iceServers: [] });
    return;
  }

  try {
    const cfResponse = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.turnKeyId}/credentials/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.turnApiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS })
    });
    if (!cfResponse.ok) {
      await logError(new Error(`Cloudflare TURN credential generation failed: ${cfResponse.status}`), {
        source: 'http',
        route: 'GET /webrtc/turn-credentials'
      });
      sendJson(res, 200, { iceServers: [] });
      return;
    }
    const data = (await cfResponse.json()) as { iceServers: { urls: string[]; username: string; credential: string } };
    sendJson(res, 200, { iceServers: [data.iceServers] });
  } catch (error) {
    await logError(error, { source: 'http', route: 'GET /webrtc/turn-credentials' });
    sendJson(res, 200, { iceServers: [] });
  }
}
