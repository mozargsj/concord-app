import type {
  ApiErrorResponse,
  CreateInviteResponse,
  CreateRoomRequest,
  CreateServerRequest,
  CreateServerResponse,
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
  UploadKind,
  UserProfile
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
}

const testState: TestModeState = { user: null, server: null, rooms: [] };

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

function httpBaseUrl(): string {
  return import.meta.env.VITE_SIGNALING_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
