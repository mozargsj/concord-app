import type { RoomSummary, ServerSummary } from '../domain/room.js';
import type { UserProfile } from '../domain/user.js';

export interface LoginRequest {
  /** [Achado de segurança, 2026-08-29] Never trusted as proof of identity on its own — the
   * Cloudflare Worker backend (packages/signaling-worker) requires and verifies `idToken` below
   * server-side, deriving the real email from that instead. Kept here (and still read by the
   * legacy packages/server backend, which never got this fix) for backward compatibility. */
  email: string;
  displayName: string;
  /** Google's `picture` claim — no longer imported anywhere server-side (decisions.md — avatar is
   * 100% local/P2P now), kept only for backward compatibility with the legacy backend. */
  avatarImageUrl?: string;
  /** Google's OAuth `id_token` (raw JWT, from main/googleAuth.ts) — packages/signaling-worker
   * verifies this server-side (signature/issuer/audience/email_verified via Google's JWKS)
   * instead of trusting `email` above directly. Optional only so the legacy packages/server
   * backend (which predates this and never checks it) still typechecks. */
  idToken?: string;
}

export interface LoginResponse {
  user: UserProfile;
  sessionToken: string;
}

/**
 * [2026-08-29, achado de segurança — item ALTO da auditoria] Antes, o Electron main process
 * (main/googleAuth.ts) trocava o `code` OAuth por tokens direto com o Google, usando
 * `GOOGLE_OAUTH_CLIENT_SECRET` embutido no `.env` de todo instalador distribuído. Não era uma
 * falha de autenticação de verdade (PKCE já protege a troca — client_secret de app nativo nunca é
 * confidencial de fato, RFC 8252), mas remover o segredo do instalador é boa prática. Agora o
 * client manda code+codeVerifier pro Worker, que guarda o `client_secret` como secret de verdade
 * (nunca sai do servidor) e faz a troca ele mesmo.
 */
export interface GoogleExchangeRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface GoogleExchangeResponse {
  idToken: string;
}

export interface UpdateProfileRequest {
  displayName?: string;
}

export interface CreateServerRequest {
  name: string;
}

export interface CreateServerResponse {
  server: ServerSummary;
}

export interface UpdateServerRequest {
  name: string;
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

/** Registry entry for one of the caller's own soundboard sounds — metadata only, the audio
 * bytes never touch the backend (P2P-only, same as avatar/server-icon, decisions.md). */
export interface UserSoundSummary {
  id: string;
  name: string;
  emoji: string;
  /** 0-1, fixed at creation — see decisions.md, this is one of the two soundboard volumes. */
  volume: number;
  durationMs: number;
  hash: string;
}

export interface CreateUserSoundRequest {
  /** Client-generated (crypto.randomUUID()) — the client already named the local cache file
   * under this id before the registry call happens, so both sides must agree on it. */
  id: string;
  name: string;
  emoji: string;
  volume: number;
  durationMs: number;
  hash: string;
}

export interface UpdateUserSoundRequest {
  name?: string;
  emoji?: string;
  volume?: number;
}

export interface UserSoundListResponse {
  sounds: UserSoundSummary[];
}

export interface UserSoundResponse {
  sound: UserSoundSummary;
}

export interface ApiErrorResponse {
  error: string;
}

// decisions.md §7 — client-side errors reported to the same system_logs/server_logs pipeline as
// server-side ones. Session is optional server-side (an error can happen before login exists).
export interface ClientErrorReportRequest {
  errorType: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

// decisions.md §7 — bug/melhoria reportado pelo usuário via UI, distinto da captura automática
// de erro acima. Session required (unlike client-error) — this is a person telling us something,
// always tied to whoever is logged in.
export type ReportType = 'bug' | 'suggestion';

export interface CreateReportRequest {
  type: ReportType;
  message: string;
  /** Optional — a report can be filed from a screen with no server context (e.g. the profile page). */
  serverId?: string;
}
