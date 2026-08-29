import type { RoomDurableObject } from './room';
import type { UpdatesBroadcaster } from './updatesBroadcaster';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
  /** Singleton (idFromName('global')) — server->client "update available" push, see
   * updatesBroadcaster.ts. Not room-scoped, unrelated to ROOMS. */
  UPDATES: DurableObjectNamespace<UpdatesBroadcaster>;
  DB: D1Database;
  /** Native R2 binding — used for direct in-Worker reads/writes (update artifacts, Google avatar
   * import) that don't need a presigned URL handed to the client. See src/r2.ts for the separate
   * aws4fetch-based presigned-URL path used for client uploads/downloads. */
  MEDIA: R2Bucket;

  // Secrets — set via `wrangler secret put <NAME>`, never in wrangler.jsonc.
  SESSION_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** Cloudflare Realtime TURN key (Dashboard: Calls > TURN Keys) — optional, see rest.ts's
   * turn-credentials handler. Blank means the client falls back to STUN-only. */
  TURN_KEY_ID: string;
  TURN_API_TOKEN: string;
  /** Shared secret checked by POST /admin/notify-update (rest.ts) — CI (or a manual call) uses
   * this to authorize broadcasting "update available" to every connected client. Not tied to any
   * existing credential; generated fresh for this one purpose. */
  ADMIN_SECRET: string;

  // Plain vars — see wrangler.jsonc "vars".
  ALLOW_UNAUTHENTICATED_ROOMS: string;
  CF_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  /** OAuth client ID (public — same value shipped in packages/client/.env), used as the expected
   * `aud` claim when verifying a Google id_token server-side. See src/googleAuth.ts. */
  GOOGLE_OAUTH_CLIENT_ID: string;
}
