import type { RoomDurableObject } from './room';
import type { UpdatesBroadcaster } from './updatesBroadcaster';
import type { ServerPresence } from './presence';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
  /** Singleton (idFromName('global')) — server->client "update available" push, see
   * updatesBroadcaster.ts. Not room-scoped, unrelated to ROOMS. */
  UPDATES: DurableObjectNamespace<UpdatesBroadcaster>;
  /** One per server (idFromName(serverId)) — who is in each room, for members outside it (presence.ts). */
  PRESENCE: DurableObjectNamespace<ServerPresence>;
  DB: D1Database;
  /** Native R2 binding — used for direct in-Worker reads/writes (update artifacts). Presigned
   * upload/download URLs for client-facing avatar/icon uploads (src/r2.ts, aws4fetch-based) were
   * removed 2026-08-29 — /uploads/presign was dead code (avatar/server-icon are 100% P2P/cache
   * local, decisions.md) that a security audit flagged as an unbounded R2 abuse/cost vector. */
  MEDIA: R2Bucket;

  // Secrets — set via `wrangler secret put <NAME>`, never in wrangler.jsonc.
  SESSION_SECRET: string;
  /** Cloudflare Realtime TURN key (Dashboard: Calls > TURN Keys) — optional, see rest.ts's
   * turn-credentials handler. Blank means the client falls back to STUN-only. */
  TURN_KEY_ID: string;
  TURN_API_TOKEN: string;
  /** Shared secret checked by POST /admin/notify-update (rest.ts) — CI (or a manual call) uses
   * this to authorize broadcasting "update available" to every connected client. Not tied to any
   * existing credential; generated fresh for this one purpose. */
  ADMIN_SECRET: string;
  /** [2026-08-29] Moved here from packages/client/.env (see rest.ts's handleGoogleExchange) — the
   * one place this secret should have ever lived. Never sent to any client, never in wrangler.jsonc. */
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  /** Cloudflare Realtime SFU app (Dashboard: Realtime > SFU) — both blank = SFU unavailable, every
   * room stays mesh whatever servers.media_mode says (src/sfu.ts sfuConfigured). */
  REALTIME_SFU_APP_ID: string;
  REALTIME_SFU_APP_SECRET: string;

  // Plain vars — see wrangler.jsonc "vars".
  ALLOW_UNAUTHENTICATED_ROOMS: string;
  /** Optional, meant for `.dev.vars`: 'sfu' or 'mesh' forces that mode for every room instead of
   * each server's servers.media_mode (local testing with the fake test-dev servers). Unset in production. */
  MEDIA_MODE_OVERRIDE?: string;
  /** OAuth client ID (public — same value shipped in packages/client/.env), used as the expected
   * `aud` claim when verifying a Google id_token server-side. See src/googleAuth.ts. */
  GOOGLE_OAUTH_CLIENT_ID: string;

  // Rate Limiting bindings (see wrangler.jsonc "ratelimits" and src/rateLimit.ts) — one per
  // protected route/upgrade, distinct limits per sensitivity.
  LOGIN_LIMITER: RateLimit;
  TURN_LIMITER: RateLimit;
  LOG_LIMITER: RateLimit;
  WS_LIMITER: RateLimit;
  OAUTH_EXCHANGE_LIMITER: RateLimit;
}
