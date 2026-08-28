import type {
  ApiErrorResponse,
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
  UploadKind,
  UserProfile,
  UserSoundListResponse,
  UserSoundResponse,
  UserSoundSummary
} from '@concord/shared';

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number
  ) {
    super(`${code} (${status})`);
  }
}

/**
 * [MODO TESTE — TEMPORÁRIO, TIRAR NA VERSÃO ESTÁVEL]
 * Contorna toda chamada que dependeria do backend real (login, servidor, sala) com um estado
 * fake em memória, pra dar pra navegar o app e testar o mesh WebRTC (o fluxo principal) enquanto
 * o acesso à AWS local segue bloqueado. Liga via VITE_TEST_MODE=true no .env — o .env.example
 * fica sempre com false, então um checkout novo já nasce com o fluxo real (Google OAuth).
 * Sala usa um id determinístico a partir do nome (não aleatório) justamente pra duas instâncias
 * de teste independentes (duas janelas) conseguirem entrar na MESMA sala de sinalização real
 * digitando o mesmo nome — a sinalização (join-room/SDP/ICE) continua 100% real, só a parte
 * REST/DynamoDB (conta, servidor, sala como registro) é que é fake.
 */
export const TEST_MODE = import.meta.env.VITE_TEST_MODE === 'true';

// [MODO TESTE OFFLINE — TEMPORÁRIO] Sub-flag do modo teste — além da conta/servidor/sala serem
// fake, a sinalização (WebSocket) também vira fake, sem nenhuma dependência de servidor (nem
// local nem produção). Ver useRoomConnection.ts. Só faz sentido com TEST_MODE=true.
export const TEST_OFFLINE = import.meta.env.VITE_TEST_OFFLINE === 'true';

interface TestModeState {
  user: UserProfile | null;
  server: ServerSummary | null;
  rooms: RoomSummary[];
  sounds: UserSoundSummary[];
}

const testState: TestModeState = { user: null, server: null, rooms: [], sounds: [] };

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

let sessionToken: string | null = null;

/** Applied as the Authorization header on every request from here on — set once after login/restore. */
export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

/** Read access for callers that need the raw token itself, not just the Authorization header this
 * module already attaches — currently just useRoomConnection.ts, which sends it over the
 * signaling WebSocket so the server can verify room membership on join (roomManager.ts). */
export function getSessionToken(): string | null {
  return sessionToken;
}

let onUnauthorized: (() => void) | null = null;

/** App.tsx registers this once — every authenticated request goes through `request()` below, so
 * this is the single choke point that catches a session going invalid both at boot (restoring a
 * stale stored token) and mid-session (token expires — or the server's SESSION_SECRET rotates —
 * while the app is already open), without every call site needing its own 401 handling. Only
 * fires when a token was actually attached to the failing request — a bare 401 with no token
 * attached means "never logged in", not "session expired". */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

function httpBaseUrl(): string {
  return import.meta.env.VITE_SIGNALING_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

/** Pure connectivity probe against GET /health — no session, no retries built in (caller decides
 * polling/retry policy). Bypassed in TEST_MODE: that profile never talks to a real backend for
 * account/session data in the first place (see api.ts header), so checking one here would only
 * produce false negatives. Short timeout — this gates the loading screen, it shouldn't hang it. */
export async function checkServerHealth(): Promise<boolean> {
  if (TEST_MODE) return true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${httpBaseUrl()}/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hadToken = Boolean(sessionToken);
  const response = await fetch(`${httpBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    if (response.status === 401 && hadToken) onUnauthorized?.();
    throw new ApiError(body?.error ?? 'unknown-error', response.status);
  }
  return response.json() as Promise<T>;
}

export async function login(
  email: string,
  displayName: string,
  avatarImageUrl?: string
): Promise<{ user: UserProfile; sessionToken: string }> {
  if (TEST_MODE) {
    testState.user = {
      id: testState.user?.id ?? `test-user-${slugify(email)}`,
      email,
      displayName,
      avatarUrl: null,
      ownedServerId: testState.server?.id ?? null
    };
    return { user: testState.user, sessionToken: 'test-mode-token' };
  }
  const body: LoginRequest = { email, displayName, avatarImageUrl };
  return request<LoginResponse>('/users', { method: 'POST', body: JSON.stringify(body) });
}

export async function getCurrentUser(): Promise<UserProfile> {
  if (TEST_MODE) {
    // In-memory state doesn't survive an app restart — session restore just bounces back to
    // login in test mode, which is fine for this throwaway scaffolding.
    if (!testState.user) throw new ApiError('unauthorized', 401);
    return testState.user;
  }
  const result = await request<{ user: UserProfile }>('/users/me');
  return result.user;
}

export async function updateProfile(patch: UpdateProfileRequest): Promise<UserProfile> {
  if (TEST_MODE) {
    if (!testState.user) throw new ApiError('unauthorized', 401);
    testState.user = {
      ...testState.user,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {})
    };
    return testState.user;
  }
  const result = await request<{ user: UserProfile }>('/users/me', {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  return result.user;
}

export async function createServer(name: string, iconKey?: string): Promise<ServerSummary> {
  if (TEST_MODE) {
    if (!testState.user) throw new ApiError('unauthorized', 401);
    if (testState.server) throw new ApiError('already-owns-server', 409);
    testState.server = { id: `test-server-${slugify(name)}`, name, iconUrl: null, ownerUserId: testState.user.id };
    testState.user = { ...testState.user, ownedServerId: testState.server.id };
    return testState.server;
  }
  const body: CreateServerRequest = { name, iconKey };
  const result = await request<CreateServerResponse>('/servers', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return result.server;
}

export async function updateServer(serverId: string, name: string): Promise<ServerSummary> {
  if (TEST_MODE) {
    if (!testState.server || testState.server.id !== serverId) throw new ApiError('server-not-found', 404);
    testState.server = { ...testState.server, name };
    return testState.server;
  }
  const body: UpdateServerRequest = { name };
  const result = await request<CreateServerResponse>(`/servers/${serverId}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
  return result.server;
}

export async function getServer(id: string): Promise<ServerDetailsResponse> {
  if (TEST_MODE) {
    if (!testState.server || testState.server.id !== id) throw new ApiError('server-not-found', 404);
    return { server: testState.server, myRole: 1 }; // Role.Dono — test user always owns its own fake server
  }
  return request<ServerDetailsResponse>(`/servers/${id}`);
}

export async function listMyServers(): Promise<ServerSummary[]> {
  if (TEST_MODE) return testState.server ? [testState.server] : [];
  const result = await request<ServerListResponse>('/users/me/servers');
  return result.servers;
}

export async function joinServerWithCode(code: string): Promise<ServerSummary> {
  if (TEST_MODE) throw new ApiError('invalid-code', 400); // cross-instance join needs a real shared backend
  const body: JoinServerRequest = { code };
  const result = await request<CreateServerResponse>('/servers/join', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return result.server;
}

export async function createInvite(serverId: string): Promise<string> {
  if (TEST_MODE) return 'test-mode-invite-unavailable';
  const result = await request<CreateInviteResponse>(`/servers/${serverId}/invites`, { method: 'POST' });
  return result.code;
}

export async function listRooms(serverId: string): Promise<RoomSummary[]> {
  if (TEST_MODE) return testState.rooms;
  const result = await request<RoomListResponse>(`/servers/${serverId}/rooms`);
  return result.rooms;
}

export async function createRoom(serverId: string, name: string): Promise<RoomSummary> {
  if (TEST_MODE) {
    // Deterministic id (not random) — lets two independent test-mode windows land in the same
    // real signaling room by just typing the same room name.
    const room: RoomSummary = { id: `test-room-${slugify(name)}`, serverId, name, memberCount: 0, maxMembers: 10 };
    testState.rooms = [...testState.rooms.filter((r) => r.id !== room.id), room];
    return room;
  }
  const body: CreateRoomRequest = { name };
  const result = await request<RoomResponse>(`/servers/${serverId}/rooms`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return result.room;
}

export async function renameRoom(serverId: string, roomId: string, name: string): Promise<RoomSummary> {
  if (TEST_MODE) {
    const room = testState.rooms.find((r) => r.id === roomId);
    if (!room) throw new ApiError('room-not-found', 404);
    room.name = name;
    testState.rooms = [...testState.rooms];
    return room;
  }
  const body: UpdateRoomRequest = { name };
  const result = await request<RoomResponse>(`/servers/${serverId}/rooms/${roomId}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
  return result.room;
}

export async function deleteRoom(serverId: string, roomId: string): Promise<void> {
  if (TEST_MODE) {
    testState.rooms = testState.rooms.filter((r) => r.id !== roomId);
    return;
  }
  await request(`/servers/${serverId}/rooms/${roomId}`, { method: 'DELETE' });
}

export async function presignUpload(
  kind: UploadKind,
  id: string,
  contentType: string
): Promise<PresignUploadResponse> {
  if (TEST_MODE) return { uploadUrl: '', key: 'test-mode-key' };
  const body: PresignUploadRequest = { kind, id, contentType };
  return request<PresignUploadResponse>('/uploads/presign', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

// Registry-only sync for the soundboard (decisions.md — seção 4): the audio bytes themselves
// never touch this API, only the metadata (name/emoji/volume/hash) that lets "meus áudios"
// survive a reinstall. Callers (soundCache.ts) treat every one of these as best-effort — the
// local disk cache is the real source of truth, this is just an opportunistic mirror.
export async function listMySounds(): Promise<UserSoundSummary[]> {
  if (TEST_MODE) return testState.sounds;
  const result = await request<UserSoundListResponse>('/users/me/sounds');
  return result.sounds;
}

export async function createUserSound(sound: CreateUserSoundRequest): Promise<UserSoundSummary> {
  if (TEST_MODE) {
    const summary: UserSoundSummary = {
      id: sound.id,
      name: sound.name,
      emoji: sound.emoji,
      volume: sound.volume,
      durationMs: sound.durationMs,
      hash: sound.hash
    };
    testState.sounds = [...testState.sounds.filter((s) => s.id !== sound.id), summary];
    return summary;
  }
  const result = await request<UserSoundResponse>('/users/me/sounds', {
    method: 'POST',
    body: JSON.stringify(sound)
  });
  return result.sound;
}

export async function updateUserSound(soundId: string, patch: UpdateUserSoundRequest): Promise<void> {
  if (TEST_MODE) {
    testState.sounds = testState.sounds.map((sound) => (sound.id === soundId ? { ...sound, ...patch } : sound));
    return;
  }
  await request(`/users/me/sounds/${soundId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteUserSound(soundId: string): Promise<void> {
  if (TEST_MODE) {
    testState.sounds = testState.sounds.filter((sound) => sound.id !== soundId);
    return;
  }
  await request(`/users/me/sounds/${soundId}`, { method: 'DELETE' });
}

/**
 * decisions.md §7 — best-effort error reporting to the same log pipeline the server writes to.
 * Must never itself throw or crash the caller (a logging failure is not a reason to compound the
 * original error), and is a no-op in TEST_MODE (no real backend to receive it).
 */
/** Unlike reportClientError below (best-effort telemetry, swallows failures), this is a real
 * user action with a form and a submit button — the caller needs to know if it actually went
 * through, so failures propagate normally. Faked like every other account/server/room mutation
 * in TEST_MODE (that profile never talks to the real backend, decisions.md). */
export async function createReport(type: CreateReportRequest['type'], message: string, serverId?: string): Promise<void> {
  if (TEST_MODE) return;
  await request('/reports', { method: 'POST', body: JSON.stringify({ type, message, serverId } satisfies CreateReportRequest) });
}

export async function reportClientError(
  errorType: string,
  message: string,
  stack?: string,
  context?: Record<string, unknown>
): Promise<void> {
  if (TEST_MODE) return;
  try {
    await request('/logs/client-error', {
      method: 'POST',
      body: JSON.stringify({ errorType, message, stack, context })
    });
  } catch {
    // Swallowed on purpose — see doc comment above.
  }
}

/**
 * [Teste de conectividade 2026-08-27] Busca credenciais TURN de curta duração (servidor local
 * gera via Cloudflare Realtime, ver router.ts) pra usar como fallback de NAT traversal ao lado do
 * STUN de sempre (webrtcMesh.ts ICE_SERVERS). Best-effort: qualquer falha (backend sem TURN
 * configurado, offline, TEST_MODE sem sessão real) devolve lista vazia — quem chama já trata isso
 * como "sem TURN disponível, segue só com STUN".
 */
export async function fetchTurnCredentials(): Promise<RTCIceServer[]> {
  if (TEST_MODE) return [];
  try {
    const result = await request<{ iceServers: RTCIceServer[] }>('/webrtc/turn-credentials');
    return result.iceServers;
  } catch {
    return [];
  }
}

export async function uploadToPresignedUrl(
  uploadUrl: string,
  data: ArrayBuffer,
  contentType: string
): Promise<void> {
  if (TEST_MODE) return;
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: data
  });
  if (!response.ok) throw new ApiError('upload-failed', response.status);
}
