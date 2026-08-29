import type { RoomDurableObject } from './room';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
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

  // Plain vars — see wrangler.jsonc "vars".
  ALLOW_UNAUTHENTICATED_ROOMS: string;
  CF_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
}
