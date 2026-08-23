import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApiErrorResponse,
  CreateServerRequest,
  CreateServerResponse,
  LoginRequest,
  LoginResponse,
  PresignUploadRequest,
  PresignUploadResponse,
  ServerSummary,
  UpdateProfileRequest,
  UserProfile
} from '@concord/shared';
import * as usersRepo from '../db/usersRepo.js';
import * as serversRepo from '../db/serversRepo.js';
import { createPresignedGetUrl, createPresignedUploadUrl, putObject } from '../aws/s3Client.js';
import { signSessionToken, verifySessionToken } from '../auth/session.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error } satisfies ApiErrorResponse);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
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
  const segments = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
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
    if (method === 'POST' && segments.length === 1 && segments[0] === 'servers') {
      await handleCreateServer(req, res);
      return;
    }
    if (method === 'GET' && segments.length === 2 && segments[0] === 'servers') {
      await handleGetServer(req, res, segments[1]);
      return;
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'uploads' && segments[1] === 'presign') {
      await handlePresignUpload(req, res);
      return;
    }
    sendError(res, 404, 'not-found');
  } catch (error) {
    console.error('HTTP handler error', error);
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
  if (!record) record = await usersRepo.create({ email, displayName });

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
  await usersRepo.updateProfile(userId, {
    displayName: body?.displayName?.trim() || undefined,
    avatarKey: body?.avatarKey || undefined
  });

  const updated = await usersRepo.findById(userId);
  sendJson(res, 200, { user: await toUserProfile(updated!) });
}

async function handleCreateServer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const body = await readJsonBody<CreateServerRequest>(req);
  const name = body?.name?.trim();
  if (!name) return sendError(res, 400, 'name-required');

  const owner = await usersRepo.findById(userId);
  if (!owner) return sendError(res, 404, 'user-not-found');
  if (owner.owned_server_id) return sendError(res, 409, 'already-owns-server');

  const existing = await serversRepo.findByNameLower(name.toLowerCase());
  if (existing) return sendError(res, 409, 'name-taken');

  const record = await serversRepo.create({ name, iconKey: body?.iconKey ?? null, ownerUserId: userId });
  await usersRepo.setOwnedServer(userId, record.server_id);

  const response: CreateServerResponse = { server: await toServerSummary(record) };
  sendJson(res, 201, response);
}

async function handleGetServer(req: IncomingMessage, res: ServerResponse, serverId: string): Promise<void> {
  const userId = await requireSession(req, res);
  if (!userId) return;

  const record = await serversRepo.findById(serverId);
  if (!record) return sendError(res, 404, 'server-not-found');
  // No cross-server visibility yet (no invite/join flow) — only the owner may look up their own server.
  if (record.owner_user_id !== userId) return sendError(res, 403, 'forbidden');

  sendJson(res, 200, { server: await toServerSummary(record) });
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
