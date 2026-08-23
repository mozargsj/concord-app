import type { RoomSummary, ServerSummary } from '../domain/room.js';
import type { UserProfile } from '../domain/user.js';

export interface LoginRequest {
  email: string;
  displayName: string;
  /** Google's `picture` claim — imported to S3 only when this login creates a brand-new account. */
  avatarImageUrl?: string;
}

export interface LoginResponse {
  user: UserProfile;
  sessionToken: string;
}

export interface UpdateProfileRequest {
  displayName?: string;
  /** S3 object key returned by /uploads/presign, not a URL — the server resolves it to a signed GET URL on read. */
  avatarKey?: string;
}

export interface CreateServerRequest {
  name: string;
  /** S3 object key returned by /uploads/presign, not a URL. */
  iconKey?: string;
}

export interface CreateServerResponse {
  server: ServerSummary;
}

/** The caller's own rank (1=dono..4=usuário, see packages/shared/src/domain/roles.ts) for this server — kept as a plain number on the wire so the client never has to import the const enum (esbuild/isolatedModules risk, see decisions.md). */
export interface ServerDetailsResponse {
  server: ServerSummary;
  myRole: number;
}

export interface ServerListResponse {
  servers: ServerSummary[];
}

export interface CreateRoomRequest {
  name: string;
}

export interface UpdateRoomRequest {
  name: string;
}

export interface RoomListResponse {
  rooms: RoomSummary[];
}

export interface RoomResponse {
  room: RoomSummary;
}

export interface CreateInviteResponse {
  code: string;
}

export interface JoinServerRequest {
  code: string;
}

export type UploadKind = 'user-avatar' | 'server-icon';

export interface PresignUploadRequest {
  kind: UploadKind;
  id: string;
  contentType: string;
}

export interface PresignUploadResponse {
  uploadUrl: string;
  key: string;
}

export interface ApiErrorResponse {
  error: string;
}
