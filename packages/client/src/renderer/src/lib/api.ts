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
  const body: LoginRequest = { email, displayName, avatarImageUrl };
  return request<LoginResponse>('/users', { method: 'POST', body: JSON.stringify(body) });
}

export async function getCurrentUser(): Promise<UserProfile> {
  const result = await request<{ user: UserProfile }>('/users/me');
  return result.user;
}

export async function updateProfile(patch: UpdateProfileRequest): Promise<UserProfile> {
  const result = await request<{ user: UserProfile }>('/users/me', {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  return result.user;
}

export async function createServer(name: string, iconKey?: string): Promise<ServerSummary> {
  const body: CreateServerRequest = { name, iconKey };
  const result = await request<CreateServerResponse>('/servers', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return result.server;
}

export async function getServer(id: string): Promise<ServerSummary> {
  const result = await request<{ server: ServerSummary }>(`/servers/${id}`);
  return result.server;
}

export async function presignUpload(
  kind: UploadKind,
  id: string,
  contentType: string
): Promise<PresignUploadResponse> {
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
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: data
  });
  if (!response.ok) throw new ApiError('upload-failed', response.status);
}
