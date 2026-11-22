import { DurableObject } from 'cloudflare:workers';
import type { PresencePeer, PresenceServerMessage } from '@concord/shared';
import type { Env } from './env';
import { verifySessionToken } from './auth';
import * as serversRepo from './db/servers';
import * as roomsRepo from './db/rooms';
import * as rolesRepo from './db/roles';

const MAX_MESSAGE_BYTES = 8 * 1024;

interface SubscriberAttachment {
  userId: string;
}

/**
 * One instance per server (env.PRESENCE.idFromName(serverId), index.ts) — tells every member who
 * has the server open who is in each of its rooms, including rooms they are not in (pedido do
 * Mozar, 2026-11-22). Nothing durable but the serverId: a new subscriber gets a snapshot read
 * straight from each RoomDurableObject's live sockets (so a room emptied by a deploy reads empty,
 * never a ghost), and after that each room pushes its own changes here (roomChanged, an RPC from
 * room.ts). Hibernation API: an idle subscriber costs nothing.
 */
export class ServerPresence extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    // Same rule as RoomDurableObject.fetch: the URL value is what index.ts used to pick this
    // object, so it is the only authoritative answer to "which server is this".
    const serverId = new URL(request.url).searchParams.get('serverId');
    if (!serverId) return new Response('Missing serverId query parameter.', { status: 400 });
    if ((await this.ctx.storage.get<string>('serverId')) !== serverId) await this.ctx.storage.put('serverId', serverId);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return;
    if (ws.deserializeAttachment() !== null) return; // one subscribe per socket
    let parsed: { type?: unknown; sessionToken?: unknown };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed?.type !== 'presence-subscribe' || typeof parsed.sessionToken !== 'string' || parsed.sessionToken.length > 4000) return;

    const serverId = (await this.ctx.storage.get<string>('serverId')) ?? '';
    const userId = await this.authorize(serverId, parsed.sessionToken);
    if (!userId) {
      ws.close(1008, 'Sem acesso a este servidor');
      return;
    }
    ws.serializeAttachment({ userId } satisfies SubscriberAttachment);

    const roomIds = (await roomsRepo.listByServer(this.env, serverId)).map((room) => room.room_id);
    const lists = await Promise.all(roomIds.map((roomId) => this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId)).presence()));
    const rooms: Record<string, PresencePeer[]> = {};
    roomIds.forEach((roomId, i) => {
      if (lists[i].length > 0) rooms[roomId] = lists[i];
    });
    this.send(ws, { type: 'presence-snapshot', rooms });
  }

  /** RPC from RoomDurableObject whenever its list of people changes. */
  async roomChanged(roomId: string, peers: PresencePeer[]): Promise<void> {
    const message: PresenceServerMessage = { type: 'presence-room', roomId, peers };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment() !== null) this.send(ws, message);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(): Promise<void> {}

  /** Same membership rule as joining a room (room.ts handleJoinRoom): owner or any rank. */
  private async authorize(serverId: string, sessionToken: string): Promise<string | null> {
    const userId = await verifySessionToken(sessionToken, this.env.SESSION_SECRET);
    if (!userId) return this.env.ALLOW_UNAUTHENTICATED_ROOMS === 'true' ? 'test-user' : null;
    const server = await serversRepo.findById(this.env, serverId);
    if (!server) return null;
    if (server.owner_user_id === userId) return userId;
    return (await rolesRepo.getRank(this.env, serverId, userId)) !== null ? userId : null;
  }

  private send(ws: WebSocket, message: PresenceServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // closing/closed — webSocketClose cleans up
    }
  }
}
