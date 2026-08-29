import type { Env } from './env';
import { handleRest } from './rest';
import * as reportsRepo from './db/reports';
import * as logsRepo from './db/logs';

export { RoomDurableObject } from './room';

/**
 * [2026-08-29] Single origin for both REST and WebSocket signaling — same shape as
 * packages/server (one Node process handles both), which the client's URL config already
 * depends on (VITE_SIGNALING_URL doubles as the REST base via a scheme swap, see
 * packages/client/src/renderer/src/lib/api.ts). A WebSocket upgrade routes to the right
 * RoomDurableObject (env.ROOMS.idFromName(roomId), see room.ts); everything else goes through
 * the REST router in rest.ts, backed by D1/R2 instead of DynamoDB/S3.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const roomId = new URL(request.url).searchParams.get('roomId');
      if (!roomId) return new Response('Missing roomId query parameter.', { status: 400 });
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    return handleRest(request, env);
  },

  /** Daily sweep for the TTL-style expiry DynamoDB used to do natively (decisions.md §7) —
   * D1/SQLite has no equivalent, so this is a Cron Trigger instead (wrangler.jsonc). */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const [reportsDeleted, logsDeleted] = await Promise.all([
      reportsRepo.deleteExpired(env, nowSeconds),
      logsRepo.deleteExpired(env, nowSeconds)
    ]);
    console.log(`[concord-signaling] expiry sweep: ${reportsDeleted} reports, ${logsDeleted} logs deleted`);
  }
} satisfies ExportedHandler<Env>;
