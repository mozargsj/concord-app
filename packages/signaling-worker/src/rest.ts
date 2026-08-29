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
import type { Env } from './env';
import * as usersRepo from './db/users';
import * as serversRepo from './db/servers';
import * as roomsRepo from './db/rooms';
import * as rolesRepo from './db/roles';
import * as authorizedUsersRepo from './db/authorizedUsers';
import * as userSoundsRepo from './db/userSounds';
import * as reportsRepo from './db/reports';
import * as r2 from './r2';
import { signSessionToken, verifySessionToken, signInviteToken, verifyInviteToken } from './auth';
import { logError } from './errorLog';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders }
  });
}

function error(status: number, err: string): Response {
  return json(status, { error: err } satisfies ApiErrorResponse);
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;

async function readJsonBody<T>(req: Request): Promise<T | null> {
  const contentLength = req.headers.get('Content-Length');
  if (contentLength && Number(contentLength) > MAX_JSON_BODY_BYTES) return null;
  try {
    const text = await req.text();
    if (!text || text.length > MAX_JSON_BODY_BYTES) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function requireSession(req: Request, env: Env): Promise<string | null> {
  const header = req.headers.get('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  return token ? verifySessionToken(token, env.SESSION_SECRET) : null;
}

async function getEffectiveRank(env: Env, serverId: string, userId: string, ownerUserId: string): Promise<Role | null> {
  if (userId === ownerUserId) return Role.Dono;
  const rank = await rolesRepo.getRank(env, serverId, userId);
  return (rank as Role | null) ?? null;
}

/** Combines requireSession with a minimum-rank check. Returns null (having already produced the
 * right error Response via the `respond` callback) on failure. */
async function requireRank(
  req: Request,
  env: Env,
  server: serversRepo.ServerRecord,
  minRank: Role
): Promise<{ userId: string } | { errorResponse: Response }> {
  const userId = await requireSession(req, env);
  if (!userId) return { errorResponse: error(401, 'unauthorized') };
  const rank = await getEffectiveRank(env, server.server_id, userId, server.owner_user_id);
  if (rank === null || !hasAtLeastRole(rank, minRank)) return { errorResponse: error(403, 'forbidden') };
  return { userId };
}

async function toUserProfile(env: Env, record: usersRepo.UserRecord): Promise<UserProfile> {
  return {
    id: record.user_id,
    email: record.email,
    displayName: record.display_name,
    avatarUrl: record.avatar_key ? await r2.createPresignedGetUrl(env, record.avatar_key) : null,
    ownedServerId: record.owned_server_id
  };
}

async function toServerSummary(env: Env, record: serversRepo.ServerRecord): Promise<ServerSummary> {
  return {
    id: record.server_id,
    name: record.name,
    iconUrl: record.icon_key ? await r2.createPresignedGetUrl(env, record.icon_key) : null,
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
  return { id: record.room_id, serverId: record.server_id, name: record.name, memberCount: 0, maxMembers: 10 };
}

/** Best-effort: downloads the Google profile picture and stores it under the new user's own avatar key. */
async function importAvatarFromUrl(env: Env, userId: string, imageUrl: string): Promise<string | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    const key = `avatars/${userId}-${Date.now()}`;
    await env.MEDIA.put(key, response.body, { httpMetadata: { contentType } });
    return key;
  } catch {
    return null;
  }
}

/** REST router — mirrors packages/server/src/http/router.ts route-for-route, reimplemented
 * against the Workers Request/Response API and the D1/R2-backed repos in src/db/ and src/r2.ts
 * instead of DynamoDB/S3. Returns null for routes it doesn't recognize, so index.ts's fetch()
 * can fall through to a plain 404 without this module needing to know about that. */
export async function handleRest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
      return json(200, { status: 'ok' });
    }
    if (segments[0] === 'updates') {
      return handleServeUpdateFile(env, segments);
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'users') {
      return await handleLogin(req, env);
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'users' && segments[1] === 'me') {
      return await handleGetMe(req, env);
    }
    if (method === 'PATCH' && segments.length === 2 && segments[0] === 'users' && segments[1] === 'me') {
      return await handleUpdateMe(req, env);
    }
    if (method === 'GET' && segments.length === 3 && segments[0] === 'users' && segments[1] === 'me' && segments[2] === 'servers') {
      return await handleListMyServers(req, env);
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'servers') {
      return await handleCreateServer(req, env);
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'servers' && segments[1] === 'join') {
      return await handleJoinServer(req, env);
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'servers') {
      return await handleGetServer(req, env, segments[1]);
    }
    if (method === 'PATCH' && segments.length === 2 && segments[0] === 'servers') {
      return await handleUpdateServer(req, env, segments[1]);
    }
    if (method === 'POST' && segments.length === 3 && segments[0] === 'servers' && segments[2] === 'invites') {
      return await handleCreateInvite(req, env, segments[1]);
    }
    if (method === 'GET' && segments.length === 3 && segments[0] === 'servers' && segments[2] === 'rooms') {
      return await handleListRooms(req, env, segments[1]);
    }
    if (method === 'POST' && segments.length === 3 && segments[0] === 'servers' && segments[2] === 'rooms') {
      return await handleCreateRoom(req, env, segments[1]);
    }
    if (method === 'PATCH' && segments.length === 4 && segments[0] === 'servers' && segments[2] === 'rooms') {
      return await handleUpdateRoom(req, env, segments[1], segments[3]);
    }
    if (method === 'DELETE' && segments.length === 4 && segments[0] === 'servers' && segments[2] === 'rooms') {
      return await handleDeleteRoom(req, env, segments[1], segments[3]);
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'uploads' && segments[1] === 'presign') {
      return await handlePresignUpload(req, env);
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'webrtc' && segments[1] === 'turn-credentials') {
      return await handleGetTurnCredentials(req, env);
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'logs' && segments[1] === 'client-error') {
      return await handleClientErrorReport(req, env);
    }
    if (method === 'POST' && segments.length === 1 && segments[0] === 'reports') {
      return await handleCreateReport(req, env);
    }
    if (method === 'GET' && segments.length === 3 && segments[0] === 'users' && segments[1] === 'me' && segments[2] === 'sounds') {
      return await handleListMySounds(req, env);
    }
    if (method === 'POST' && segments.length === 3 && segments[0] === 'users' && segments[1] === 'me' && segments[2] === 'sounds') {
      return await handleCreateSound(req, env);
    }
    if (method === 'PATCH' && segments.length === 4 && segments[0] === 'users' && segments[1] === 'me' && segments[2] === 'sounds') {
      return await handleUpdateSound(req, env, segments[3]);
    }
    if (method === 'DELETE' && segments.length === 4 && segments[0] === 'users' && segments[1] === 'me' && segments[2] === 'sounds') {
      return await handleDeleteSound(req, env, segments[3]);
    }
    return error(404, 'not-found');
  } catch (err) {
    const serverId = segments[0] === 'servers' && segments.length > 1 ? segments[1] : undefined;
    await logError(env, err, { source: 'http', route: `${method} ${url.pathname}`, serverId });
    return error(500, 'internal-error');
  }
}

/** Static file host for auto-update artifacts, read from the same R2 bucket under an `updates/`
 * prefix (native binding, not presigned — these are meant to be publicly fetchable, same as the
 * Node server's plain HTTPS directory). `no-store` on every response (hit or miss) for the same
 * reason packages/server/src/http/router.ts has it: Cloudflare caches responses, including 404s,
 * by default — a stale-cached 404 from hitting this route mid-release would block an
 * already-published artifact for hours otherwise. */
async function handleServeUpdateFile(env: Env, segments: string[]): Promise<Response> {
  if (segments.length < 2) return error(404, 'not-found');
  // env.MEDIA is unavailable until R2 is enabled on the Cloudflare account (see README) — treat
  // that exactly like "file not found" rather than a 500, same as the rest of this route's
  // not-configured-yet cases (e.g. TURN credentials below).
  if (!env.MEDIA) return json(404, { error: 'not-found' } satisfies ApiErrorResponse, { 'Cache-Control': 'no-store' });
  const key = `updates/${segments.slice(1).join('/')}`;
  const object = await env.MEDIA.get(key);
  if (!object) return json(404, { error: 'not-found' } satisfies ApiErrorResponse, { 'Cache-Control': 'no-store' });

  const contentType = key.endsWith('.yml') || key.endsWith('.yaml') ? 'application/x-yaml' : 'application/octet-stream';
  return new Response(object.body, {
    status: 200,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...CORS_HEADERS }
  });
}

async function handleLogin(req: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<LoginRequest>(req);
  const email = body?.email?.trim();
  const displayName = body?.displayName?.trim();
  if (!email) return error(400, 'email-required');
  if (!displayName) return error(400, 'display-name-required');

  let record = await usersRepo.findByEmail(env, email);
  const isNewUser = !record;
  if (!record) {
    try {
      record = await usersRepo.create(env, { email, displayName });
    } catch (err) {
      if (!(err instanceof usersRepo.UserCreateConflictError)) throw err;
      record = await usersRepo.findByEmail(env, email);
      if (!record) throw err;
    }
  }

  if (isNewUser && body?.avatarImageUrl) {
    const key = await importAvatarFromUrl(env, record.user_id, body.avatarImageUrl);
    if (key) {
      await usersRepo.updateProfile(env, record.user_id, { avatarKey: key });
      record = (await usersRepo.findById(env, record.user_id)) ?? record;
    }
  }

  const sessionToken = await signSessionToken(record.user_id, env.SESSION_SECRET);
  const response: LoginResponse = { user: await toUserProfile(env, record), sessionToken };
  return json(200, response);
}

async function handleGetMe(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const record = await usersRepo.findById(env, userId);
  if (!record) return error(404, 'user-not-found');
  return json(200, { user: await toUserProfile(env, record) });
}

async function handleUpdateMe(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const existing = await usersRepo.findById(env, userId);
  if (!existing) return error(404, 'user-not-found');

  const body = await readJsonBody<UpdateProfileRequest>(req);
  const avatarKey = body?.avatarKey || undefined;
  if (avatarKey && !avatarKey.startsWith(`avatars/${userId}-`)) return error(403, 'forbidden');
  await usersRepo.updateProfile(env, userId, { displayName: body?.displayName?.trim() || undefined, avatarKey });

  const updated = await usersRepo.findById(env, userId);
  return json(200, { user: await toUserProfile(env, updated!) });
}

async function handleListMyServers(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const serverIds = await authorizedUsersRepo.listServerIdsForUser(env, userId);
  const records = await Promise.all(serverIds.map((id) => serversRepo.findById(env, id)));
  const servers = await Promise.all(
    records.filter((record): record is serversRepo.ServerRecord => record !== null).map((r) => toServerSummary(env, r))
  );
  const response: ServerListResponse = { servers };
  return json(200, response);
}

async function handleCreateServer(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const body = await readJsonBody<CreateServerRequest>(req);
  const name = body?.name?.trim();
  if (!name) return error(400, 'name-required');
  const iconKey = body?.iconKey ?? null;
  if (iconKey && !iconKey.startsWith(`servers/${userId}-`)) return error(403, 'forbidden');

  const owner = await usersRepo.findById(env, userId);
  if (!owner) return error(404, 'user-not-found');
  if (owner.owned_server_id) return error(409, 'already-owns-server');
  const existing = await serversRepo.findByNameLower(env, name.toLowerCase());
  if (existing) return error(409, 'name-taken');

  let record: serversRepo.ServerRecord;
  try {
    record = await serversRepo.createOwned(env, { name, iconKey, ownerUserId: userId });
  } catch (err) {
    if (err instanceof serversRepo.ServerCreateConflictError) return error(409, err.reason);
    throw err;
  }
  await authorizedUsersRepo.authorize(env, record.server_id, userId);
  await rolesRepo.setRank(env, record.server_id, userId, Role.Dono);

  const response: CreateServerResponse = { server: await toServerSummary(env, record) };
  return json(201, response);
}

async function handleJoinServer(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const body = await readJsonBody<JoinServerRequest>(req);
  const code = body?.code?.trim();
  if (!code) return error(400, 'code-required');

  const serverId = await verifyInviteToken(code, env.SESSION_SECRET);
  if (!serverId) return error(400, 'invalid-code');

  const server = await serversRepo.findById(env, serverId);
  if (!server) return error(404, 'server-not-found');

  await authorizedUsersRepo.authorize(env, serverId, userId);
  const existingRank = await rolesRepo.getRank(env, serverId, userId);
  if (existingRank === null && server.owner_user_id !== userId) {
    await rolesRepo.setRank(env, serverId, userId, Role.Usuario);
  }

  const response: CreateServerResponse = { server: await toServerSummary(env, server) };
  return json(200, response);
}

async function handleGetServer(req: Request, env: Env, serverId: string): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const record = await serversRepo.findById(env, serverId);
  if (!record) return error(404, 'server-not-found');

  const myRole = await getEffectiveRank(env, serverId, userId, record.owner_user_id);
  if (myRole === null) return error(403, 'forbidden');

  const response: ServerDetailsResponse = { server: await toServerSummary(env, record), myRole };
  return json(200, response);
}

async function handleUpdateServer(req: Request, env: Env, serverId: string): Promise<Response> {
  const server = await serversRepo.findById(env, serverId);
  if (!server) return error(404, 'server-not-found');
  const rankCheck = await requireRank(req, env, server, Role.Dono);
  if ('errorResponse' in rankCheck) return rankCheck.errorResponse;

  const body = await readJsonBody<UpdateServerRequest>(req);
  const name = body?.name?.trim();
  if (!name) return error(400, 'name-required');

  if (name.toLowerCase() !== server.name_lower) {
    const existing = await serversRepo.findByNameLower(env, name.toLowerCase());
    if (existing && existing.server_id !== serverId) return error(409, 'name-taken');
  }

  await serversRepo.updateName(env, serverId, name);
  const updated = await serversRepo.findById(env, serverId);
  const response: CreateServerResponse = { server: await toServerSummary(env, updated!) };
  return json(200, response);
}

async function handleCreateInvite(req: Request, env: Env, serverId: string): Promise<Response> {
  const server = await serversRepo.findById(env, serverId);
  if (!server) return error(404, 'server-not-found');
  const rankCheck = await requireRank(req, env, server, Role.Admin);
  if ('errorResponse' in rankCheck) return rankCheck.errorResponse;

  const code = await signInviteToken(serverId, env.SESSION_SECRET);
  const response: CreateInviteResponse = { code };
  return json(200, response);
}

async function handleListRooms(req: Request, env: Env, serverId: string): Promise<Response> {
  const server = await serversRepo.findById(env, serverId);
  if (!server) return error(404, 'server-not-found');
  const rankCheck = await requireRank(req, env, server, Role.Usuario);
  if ('errorResponse' in rankCheck) return rankCheck.errorResponse;

  const records = await roomsRepo.listByServer(env, serverId);
  const response: RoomListResponse = { rooms: records.map(toRoomSummary) };
  return json(200, response);
}

async function handleCreateRoom(req: Request, env: Env, serverId: string): Promise<Response> {
  const server = await serversRepo.findById(env, serverId);
  if (!server) return error(404, 'server-not-found');
  const rankCheck = await requireRank(req, env, server, Role.Dono);
  if ('errorResponse' in rankCheck) return rankCheck.errorResponse;

  const body = await readJsonBody<CreateRoomRequest>(req);
  const name = body?.name?.trim();
  if (!name) return error(400, 'name-required');

  const record = await roomsRepo.create(env, { serverId, name });
  const response: RoomResponse = { room: toRoomSummary(record) };
  return json(201, response);
}

async function handleUpdateRoom(req: Request, env: Env, serverId: string, roomId: string): Promise<Response> {
  const server = await serversRepo.findById(env, serverId);
  if (!server) return error(404, 'server-not-found');
  const rankCheck = await requireRank(req, env, server, Role.Admin);
  if ('errorResponse' in rankCheck) return rankCheck.errorResponse;

  const existing = await roomsRepo.findById(env, serverId, roomId);
  if (!existing) return error(404, 'room-not-found');

  const body = await readJsonBody<UpdateRoomRequest>(req);
  const name = body?.name?.trim();
  if (!name) return error(400, 'name-required');

  await roomsRepo.updateName(env, serverId, roomId, name);
  const updated = await roomsRepo.findById(env, serverId, roomId);
  const response: RoomResponse = { room: toRoomSummary(updated!) };
  return json(200, response);
}

async function handleDeleteRoom(req: Request, env: Env, serverId: string, roomId: string): Promise<Response> {
  const server = await serversRepo.findById(env, serverId);
  if (!server) return error(404, 'server-not-found');
  const rankCheck = await requireRank(req, env, server, Role.Dono);
  if ('errorResponse' in rankCheck) return rankCheck.errorResponse;

  await roomsRepo.remove(env, serverId, roomId);
  return json(200, {});
}

async function handleListMySounds(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const records = await userSoundsRepo.listByUser(env, userId);
  const response: UserSoundListResponse = { sounds: records.map(toUserSoundSummary) };
  return json(200, response);
}

async function handleCreateSound(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const body = await readJsonBody<CreateUserSoundRequest>(req);
  const id = body?.id?.trim();
  const name = body?.name?.trim();
  if (!id) return error(400, 'id-required');
  if (!name) return error(400, 'name-required');
  if (typeof body?.durationMs !== 'number' || typeof body?.volume !== 'number' || !body?.hash) {
    return error(400, 'invalid-request');
  }

  const record = await userSoundsRepo.create(env, {
    userId,
    soundId: id,
    name,
    emoji: body.emoji ?? '',
    volume: body.volume,
    durationMs: body.durationMs,
    hash: body.hash
  });
  const response: UserSoundResponse = { sound: toUserSoundSummary(record) };
  return json(201, response);
}

async function handleUpdateSound(req: Request, env: Env, soundId: string): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const body = await readJsonBody<UpdateUserSoundRequest>(req);
  await userSoundsRepo.updateMeta(env, userId, soundId, {
    name: body?.name?.trim() || undefined,
    emoji: body?.emoji,
    volume: body?.volume
  });
  return json(200, {});
}

async function handleDeleteSound(req: Request, env: Env, soundId: string): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  await userSoundsRepo.remove(env, userId, soundId);
  return json(200, {});
}

async function handleClientErrorReport(req: Request, env: Env): Promise<Response> {
  const header = req.headers.get('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const userId = token ? await verifySessionToken(token, env.SESSION_SECRET) : null;

  const body = await readJsonBody<ClientErrorReportRequest>(req);
  if (!body?.errorType || !body?.message) return error(400, 'invalid-request');

  const context = body.context && typeof body.context === 'object' ? body.context : undefined;
  const serverId = typeof context?.serverId === 'string' ? context.serverId : undefined;

  const clientError = new Error(body.message);
  clientError.name = body.errorType;
  if (body.stack) clientError.stack = body.stack;

  await logError(env, clientError, {
    source: 'client',
    route: body.errorType,
    userId: userId ?? undefined,
    serverId,
    roomId: typeof context?.roomId === 'string' ? context.roomId : undefined,
    peerId: typeof context?.peerId === 'string' ? context.peerId : undefined,
    kind: typeof context?.kind === 'string' ? context.kind : undefined
  });

  return json(200, {});
}

async function handleCreateReport(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const body = await readJsonBody<CreateReportRequest>(req);
  const message = body?.message?.trim();
  if (!body?.type || (body.type !== 'bug' && body.type !== 'suggestion') || !message) {
    return error(400, 'invalid-request');
  }

  await reportsRepo.create(env, { userId, type: body.type, message, serverId: body.serverId });
  return json(200, {});
}

async function handlePresignUpload(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  const body = await readJsonBody<PresignUploadRequest>(req);
  if (!body?.kind || !body.id || !body.contentType) return error(400, 'invalid-request');
  if (body.id !== userId) return error(403, 'forbidden');

  const prefix = body.kind === 'user-avatar' ? 'avatars' : 'servers';
  const key = `${prefix}/${body.id}-${Date.now()}`;
  const uploadUrl = await r2.createPresignedUploadUrl(env, key, body.contentType);
  const response: PresignUploadResponse = { uploadUrl, key };
  return json(200, response);
}

const TURN_CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;

async function handleGetTurnCredentials(req: Request, env: Env): Promise<Response> {
  const userId = await requireSession(req, env);
  if (!userId) return error(401, 'unauthorized');

  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
    return json(200, { iceServers: [] });
  }

  try {
    const cfResponse = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS })
    });
    if (!cfResponse.ok) {
      await logError(env, new Error(`Cloudflare TURN credential generation failed: ${cfResponse.status}`), {
        source: 'http',
        route: 'GET /webrtc/turn-credentials'
      });
      return json(200, { iceServers: [] });
    }
    const data = (await cfResponse.json()) as { iceServers: { urls: string[]; username: string; credential: string } };
    return json(200, { iceServers: [data.iceServers] });
  } catch (err) {
    await logError(env, err, { source: 'http', route: 'GET /webrtc/turn-credentials' });
    return json(200, { iceServers: [] });
  }
}
