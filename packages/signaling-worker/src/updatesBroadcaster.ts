import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

/**
 * One singleton instance (env.UPDATES.idFromName('global')) — a server-to-client-only broadcast
 * channel, completely separate from the per-room signaling in room.ts. Every running Concord
 * instance connects here once at startup (not tied to being in a room, or even logged in) so it
 * can be told "a new version exists" while already open — the client never auto-installs on its
 * own from this (decisions.md: the user has to click to authorize it), this DO only delivers the
 * notification.
 *
 * Deliberately not folded into RoomDurableObject: room state is per-room and torn down when
 * empty, this is a single long-lived fan-out point unrelated to any room's lifecycle.
 */
export class UpdatesBroadcaster extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Internal-only: called from rest.ts's POST /admin/notify-update after that route has already
    // checked ADMIN_SECRET — this DO trusts whatever calls its own fetch(), same as any Durable
    // Object stub call (never reachable directly from outside the Worker).
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      const body = (await request.json()) as { version?: string };
      if (!body.version) return new Response('missing version', { status: 400 });
      const message = JSON.stringify({ type: 'update-available', version: body.version });
      let delivered = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
          delivered++;
        } catch {
          // Socket already closing/closed — webSocketClose will clean it up on its own.
        }
      }
      return new Response(JSON.stringify({ delivered }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('not found', { status: 404 });
  }

  // Server->client only channel — nothing a client sends here is meaningful, but the handlers
  // must exist for the Hibernation API's WebSocket lifecycle to work at all.
  async webSocketMessage(): Promise<void> {}
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
  async webSocketError(): Promise<void> {}
}
