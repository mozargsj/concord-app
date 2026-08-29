import { DurableObject } from 'cloudflare:workers';
import type { ClientToServerMessage, DeviceKind, ServerToClientMessage } from '@concord/shared';
import type { Env } from './env';
import { validateClientMessage } from './protocol';
import { verifySessionToken } from './auth';
import * as usersRepo from './db/users';
import * as serversRepo from './db/servers';
import * as roomsRepo from './db/rooms';
import * as rolesRepo from './db/roles';

const ROOM_CAP = 10;
const CANDIDATE_BATCH_SIZE = 3;
const CONFIRM_TIMEOUT_MS = 2000;
// Same rationale/value as the `ws` maxPayload cap in packages/server/src/websocket/server.ts —
// generous headroom above any real message, caps how much a hostile/misbehaving client can force
// this object to buffer.
const MAX_MESSAGE_BYTES = 128 * 1024;

interface PeerAttachment {
  peerId: string;
  userId: string;
  displayName: string;
  joinedAt: number;
}

interface PendingMigration {
  epoch: number;
  batch: string[];
  alreadyTried: string[];
}

/**
 * One instance per room (Worker routes by env.ROOMS.idFromName(roomId), see index.ts) — this
 * object's live state IS the room. Rewritten from scratch against packages/server's
 * roomManager.ts/connectionHandler.ts (Node + `ws`, one persistent process, room state in a
 * plain `Map<roomId, Room>`) rather than ported, because that model doesn't carry over:
 *
 * - A Durable Object can be evicted from memory between messages (hibernation) to stay inside
 *   the Workers Free plan's 13,000 GB-s/day compute-duration budget — see decisions.md §2,
 *   "Cloudflare Free plan" subsection. A plain in-memory `Map` would silently lose every peer,
 *   the host pointer, and any in-flight migration the moment that happens.
 * - `ctx.acceptWebSocket` + `serializeAttachment`/`deserializeAttachment` (not `ws.accept()` +
 *   a Map keyed by socket identity) is what makes per-peer state (peerId/userId/displayName/
 *   joinedAt) survive hibernation — see handleJoinRoom below.
 * - `setTimeout` does not survive hibernation either — the host-migration cascade
 *   (roomManager.ts's `startMigration`, CONFIRM_TIMEOUT_MS per batch) is reimplemented on the DO
 *   Alarms API instead (`ctx.storage.setAlarm` + `alarm()`), which is durable across eviction.
 * - Room-level state that must survive a hibernate/wake cycle (hostPeerId, epoch,
 *   pendingMigration, roomId) lives in `ctx.storage` (SQLite-backed — see wrangler.jsonc). Peer
 *   presence itself is never duplicated into storage: `ctx.getWebSockets()` + each socket's
 *   attachment is already the durable source of truth for "who's actually still connected."
 */
export class RoomDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // [Achado de segurança, 2026-08-29] This is the ONLY place roomId is ever set for this DO
    // instance — the URL's roomId is exactly what index.ts used to pick this Durable Object
    // (env.ROOMS.idFromName(roomId)), so it's the one value that's actually authoritative about
    // which room this object *is*. Before this, handleJoinRoom trusted the room-room/serverId
    // fields inside the join-room *message* instead (fully client-controlled, independent of the
    // URL) and even overwrote this DO's stored roomId with that value — so a session token valid
    // for the caller's own room B could join-room claiming roomId=B while physically connected to
    // room A's Durable Object (picked via ?roomId=A in the URL), passing the membership check
    // (against B, which they really belong to) while actually receiving A's peer roster/SDP/ICE.
    // handleJoinRoom below now rejects any join-room whose message.roomId disagrees with this.
    const roomId = new URL(request.url).searchParams.get('roomId');
    if (!roomId) return new Response('Missing roomId query parameter.', { status: 400 });
    await this.setRoomId(roomId);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const validated = validateClientMessage(parsed);
    if (!validated) return;

    try {
      await this.dispatch(ws, validated);
    } catch (error) {
      console.error(`signaling: ${validated.type} handler threw`, error);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    void wasClean;
    await this.handleDisconnect(ws);
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('signaling: websocket error', error);
    await this.handleDisconnect(ws);
  }

  /** Durable Object Alarms are the hibernation-safe replacement for the Node server's
   * `setTimeout` per migration batch — see the class doc comment above. */
  async alarm(): Promise<void> {
    const pending = await this.getPendingMigration();
    if (!pending) return; // already resolved by a host-candidate-confirm before this fired
    await this.setPendingMigration(null);
    await this.startMigration([...pending.alreadyTried, ...pending.batch]);
  }

  private async dispatch(ws: WebSocket, message: ClientToServerMessage): Promise<void> {
    switch (message.type) {
      case 'join-room':
        await this.handleJoinRoom(ws, message);
        break;
      case 'sdp-offer':
      case 'sdp-answer':
      case 'ice-candidate':
      case 'peer-mute-status':
        this.relay(ws, message);
        break;
      case 'host-heartbeat':
        // Same as roomManager.ts today: recorded for a future missed-heartbeat watchdog, not
        // acted on yet — migration only triggers on a real disconnect (webSocketClose).
        break;
      case 'host-candidate-confirm':
        await this.handleCandidateConfirm(ws, message.epoch);
        break;
      case 'ping':
        this.send(ws, { type: 'pong', nonce: message.nonce });
        break;
      case 'device-switched':
        await this.handleDeviceSwitched(ws, message.kind);
        break;
      case 'mic-state':
        await this.handleMicState(ws, message.isMicMuted, message.isDeafened);
        break;
      case 'screen-share-changed':
        await this.handleScreenShareChanged(ws, message.isSharing);
        break;
      case 'avatar-changed':
        await this.handleAvatarChanged(ws);
        break;
      case 'server-icon-changed':
        await this.handleServerIconChanged(ws, message.serverId);
        break;
    }
  }

  // ---- join / membership --------------------------------------------------------------------

  /** Mirrors roomManager.ts joinRoom's authorization rule exactly: verify sessionToken first: if
   * that checks out, the claimed userId is ignored entirely and membership (owner or has a role
   * row) is confirmed against DynamoDB. Only when the token doesn't verify AND
   * ALLOW_UNAUTHENTICATED_ROOMS is 'true' (local/test-dev only, see wrangler.jsonc) does the
   * client-claimed userId get trusted at all. */
  private async handleJoinRoom(
    ws: WebSocket,
    message: Extract<ClientToServerMessage, { type: 'join-room' }>
  ): Promise<void> {
    if (ws.deserializeAttachment() !== null) return; // one join per socket, same as roomManager.ts

    // Must match the URL-derived roomId set in fetch() — see that method's doc comment. A
    // mismatch means whatever roomId this join-room claims isn't actually the room this
    // connection is physically attached to, regardless of whether the caller is a legitimate
    // member of the room they *named*.
    const actualRoomId = await this.getRoomId();
    if (message.roomId !== actualRoomId) {
      this.send(ws, { type: 'join-rejected', roomId: message.roomId, reason: 'forbidden' });
      return;
    }

    const verifiedUserId = await verifySessionToken(message.sessionToken, this.env.SESSION_SECRET);
    let userId: string;
    // [Achado de segurança, 2026-08-29] Só populado no ramo autenticado (abaixo) — displayName
    // aqui vem do próprio D1, pelo userId já verificado, nunca do que a mensagem join-room alega.
    // Antes, um caller falando o protocolo WebSocket direto (sem passar pelo Electron real, que
    // sempre manda currentUser.displayName — o nickname de verdade) podia entrar numa sala
    // alegando qualquer nome, inclusive o de outro membro real dessa sala (impersonação visual,
    // sem afetar userId/permissão, que continuam 100% verificados). Corrigido buscando o nickname
    // real em vez de confiar no texto livre da mensagem.
    let verifiedDisplayName: string | null = null;
    if (verifiedUserId) {
      const server = await serversRepo.findById(this.env, message.serverId);
      const roomRecord = server ? await roomsRepo.findById(this.env, message.serverId, message.roomId) : null;
      const isMember =
        server !== null &&
        (verifiedUserId === server.owner_user_id ||
          (await rolesRepo.getRank(this.env, message.serverId, verifiedUserId)) !== null);
      if (!server || !roomRecord || !isMember) {
        this.send(ws, { type: 'join-rejected', roomId: message.roomId, reason: 'forbidden' });
        return;
      }
      userId = verifiedUserId;
      const userRecord = await usersRepo.findById(this.env, verifiedUserId);
      verifiedDisplayName = userRecord?.display_name ?? null;
    } else if (this.env.ALLOW_UNAUTHENTICATED_ROOMS === 'true') {
      userId = message.userId;
    } else {
      this.send(ws, { type: 'join-rejected', roomId: message.roomId, reason: 'unauthorized' });
      return;
    }

    const existingPeers = this.livePeers();
    if (existingPeers.length >= ROOM_CAP) {
      this.send(ws, { type: 'join-rejected', roomId: message.roomId, reason: 'room-full' });
      return;
    }

    // Fora do ramo autenticado (só o bypass ALLOW_UNAUTHENTICATED_ROOMS, nunca produção — ver
    // acima), não existe um nickname de D1 pra confiar, então cai de volta pro que a mensagem
    // mandou — mesmo trim/cap defensivo de sempre, roomManager.ts tinha o mesmo padrão.
    const safeDisplayName = (verifiedDisplayName ?? message.displayName).trim().slice(0, 60) || 'Peer';
    const safeUserId = userId.trim().slice(0, 100) || crypto.randomUUID();
    const peer: PeerAttachment = {
      peerId: crypto.randomUUID(),
      userId: safeUserId,
      displayName: safeDisplayName,
      joinedAt: Date.now()
    };
    ws.serializeAttachment(peer);

    let hostPeerId = await this.getHostPeerId();
    if (hostPeerId === null) {
      hostPeerId = peer.peerId; // host = first peer to connect, same rule as roomManager.ts
      await this.setHostPeerId(hostPeerId);
    }
    const epoch = await this.getEpoch();

    this.send(ws, {
      type: 'room-joined',
      roomId: message.roomId,
      peerId: peer.peerId,
      hostPeerId,
      epoch,
      peers: existingPeers.map((p) => ({ peerId: p.peerId, displayName: p.displayName, userId: p.userId }))
    });

    this.broadcast(
      { type: 'peer-joined', roomId: message.roomId, peerId: peer.peerId, displayName: safeDisplayName, userId: safeUserId },
      peer.peerId
    );
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;

    const roomId = await this.getRoomId();
    this.broadcast({ type: 'peer-left', roomId, peerId: peer.peerId }, peer.peerId);

    const hostPeerId = await this.getHostPeerId();
    if (hostPeerId !== peer.peerId) return;

    const stillHere = this.livePeers().filter((p) => p.peerId !== peer.peerId);
    if (stillHere.length === 0) {
      await this.setHostPeerId(null);
      await this.setPendingMigration(null);
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.startMigration([]);
    }
  }

  // ---- host migration -------------------------------------------------------------------------

  /**
   * Notifies up to CANDIDATE_BATCH_SIZE peers (ranked by connection uptime) in parallel; the
   * first to confirm within CONFIRM_TIMEOUT_MS wins (handleCandidateConfirm). If none confirm,
   * the alarm() handler above cascades to the next batch. Once every peer's been tried, the room
   * closes. Same algorithm as roomManager.ts's startMigration — timeout is a DO Alarm instead of
   * setTimeout (see class doc comment).
   */
  private async startMigration(alreadyTried: string[]): Promise<void> {
    const roomId = await this.getRoomId();
    const candidates = this.livePeers()
      .filter((p) => !alreadyTried.includes(p.peerId))
      .sort((a, b) => a.joinedAt - b.joinedAt);

    if (candidates.length === 0) {
      this.broadcast({ type: 'room-closed', roomId });
      await this.setHostPeerId(null);
      await this.setPendingMigration(null);
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const batch = candidates.slice(0, CANDIDATE_BATCH_SIZE);
    const epoch = (await this.getEpoch()) + 1;
    await this.setEpoch(epoch);
    await this.setPendingMigration({ epoch, batch: batch.map((p) => p.peerId), alreadyTried });
    await this.ctx.storage.setAlarm(Date.now() + CONFIRM_TIMEOUT_MS);

    for (const candidate of batch) {
      this.sendToPeer(candidate.peerId, { type: 'host-candidate-notify', roomId, epoch });
    }
  }

  private async handleCandidateConfirm(ws: WebSocket, epoch: number): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;
    const pending = await this.getPendingMigration();
    if (!pending || pending.epoch !== epoch || !pending.batch.includes(peer.peerId)) return; // stale/superseded round

    await this.setPendingMigration(null);
    await this.ctx.storage.deleteAlarm();
    await this.setHostPeerId(peer.peerId);
    const roomId = await this.getRoomId();
    this.broadcast({ type: 'host-changed', roomId, hostPeerId: peer.peerId, epoch });
  }

  // ---- passthrough presence signals (no server-side state, just relay to the room) ------------

  private async handleDeviceSwitched(ws: WebSocket, kind: DeviceKind): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;
    const roomId = await this.getRoomId();
    this.broadcast({ type: 'peer-device-switched', roomId, peerId: peer.peerId, kind }, peer.peerId);
  }

  private async handleMicState(ws: WebSocket, isMicMuted: boolean, isDeafened: boolean): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;
    const roomId = await this.getRoomId();
    // Not excluding the sender — matches roomManager.ts: this drives a persistent UI indicator
    // next to the sender's own name on every other client too, not a one-off sound.
    this.broadcast({ type: 'peer-mic-state', roomId, peerId: peer.peerId, isMicMuted, isDeafened });
  }

  private async handleScreenShareChanged(ws: WebSocket, isSharing: boolean): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;
    const roomId = await this.getRoomId();
    this.broadcast({ type: 'peer-screen-share-changed', roomId, peerId: peer.peerId, isSharing }, peer.peerId);
  }

  private async handleAvatarChanged(ws: WebSocket): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;
    const roomId = await this.getRoomId();
    this.broadcast({ type: 'peer-avatar-changed', roomId, peerId: peer.peerId, userId: peer.userId }, peer.peerId);
  }

  private async handleServerIconChanged(ws: WebSocket, serverId: string): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;
    const roomId = await this.getRoomId();
    this.broadcast({ type: 'peer-server-icon-changed', roomId, peerId: peer.peerId, serverId }, peer.peerId);
  }

  private relay(
    ws: WebSocket,
    message: Extract<ClientToServerMessage, { type: 'sdp-offer' | 'sdp-answer' | 'ice-candidate' | 'peer-mute-status' }>
  ): void {
    const sender = ws.deserializeAttachment() as PeerAttachment | null;
    if (!sender) return;
    this.sendToPeer(message.targetPeerId, { ...message, fromPeerId: sender.peerId });
  }

  // ---- low-level socket helpers -----------------------------------------------------------------

  /** The durable source of truth for "who's in the room" — never duplicated into ctx.storage. */
  private livePeers(): PeerAttachment[] {
    return this.ctx
      .getWebSockets()
      .map((s) => s.deserializeAttachment() as PeerAttachment | null)
      .filter((p): p is PeerAttachment => p !== null);
  }

  private send(ws: WebSocket, message: ServerToClientMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Already closing/closed — webSocketClose/webSocketError will run the real cleanup.
    }
  }

  private sendToPeer(peerId: string, message: ServerToClientMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      if (attachment?.peerId === peerId) {
        this.send(ws, message);
        return;
      }
    }
  }

  private broadcast(message: ServerToClientMessage, excludePeerId?: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      if (attachment && attachment.peerId !== excludePeerId) this.send(ws, message);
    }
  }

  // ---- durable room-level state — survives hibernation/eviction, see class doc comment ----------

  private async getRoomId(): Promise<string> {
    return (await this.ctx.storage.get<string>('roomId')) ?? '';
  }

  private async setRoomId(roomId: string): Promise<void> {
    if ((await this.getRoomId()) === roomId) return;
    await this.ctx.storage.put('roomId', roomId);
  }

  private async getHostPeerId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>('hostPeerId')) ?? null;
  }

  private async setHostPeerId(id: string | null): Promise<void> {
    if (id === null) await this.ctx.storage.delete('hostPeerId');
    else await this.ctx.storage.put('hostPeerId', id);
  }

  private async getEpoch(): Promise<number> {
    return (await this.ctx.storage.get<number>('epoch')) ?? 0;
  }

  private async setEpoch(epoch: number): Promise<void> {
    await this.ctx.storage.put('epoch', epoch);
  }

  private async getPendingMigration(): Promise<PendingMigration | null> {
    return (await this.ctx.storage.get<PendingMigration>('pendingMigration')) ?? null;
  }

  private async setPendingMigration(pending: PendingMigration | null): Promise<void> {
    if (pending === null) await this.ctx.storage.delete('pendingMigration');
    else await this.ctx.storage.put('pendingMigration', pending);
  }
}
