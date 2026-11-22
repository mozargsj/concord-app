import { DurableObject } from 'cloudflare:workers';
import type {
  ClientToServerMessage,
  DeviceKind,
  MediaMode,
  PresencePeer,
  PresenceStatus,
  ServerToClientMessage,
  SfuResultMessage,
  SfuTrackRole
} from '@concord/shared';
import type { Env } from './env';
import { validateClientMessage } from './protocol';
import { verifySessionToken } from './auth';
import { logError } from './errorLog';
import * as sfu from './sfu';
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
// Heartbeat watchdog: every client pings every 4s (useRoomConnection.ts PING_INTERVAL_MS) and any
// message counts as a sign of life. A peer silent for this long is dead (process killed, network
// gone, machine asleep) even though its socket never closed — without this it stays in the room
// forever, visible to everyone as a ghost, until the same account happens to rejoin.
const PEER_TIMEOUT_MS = 30_000;

interface PeerAttachment {
  peerId: string;
  userId: string;
  displayName: string;
  joinedAt: number;
  /** Last message received from this peer — optional because attachments persisted before the
   * watchdog existed don't have it (joinedAt stands in). */
  lastSeenAt?: number;
  /** Optional for the same reason as lastSeenAt: attachments persisted before it existed. */
  status?: PresenceStatus;
  /** SFU rooms only. Lives in the attachment (2 KiB cap; this stays well under it) so it survives
   * hibernation and dies with the socket — a rejoin starts with fresh SFU sessions. */
  sfu?: SfuPeerState;
}

interface SfuPeerState {
  /** Publisher and subscriber session ids at the SFU. */
  pub?: string;
  sub?: string;
  /** Published tracks: role, SFU track name, mid on the publisher connection. */
  tracks?: { role: SfuTrackRole; name: string; mid: string }[];
}

type SfuClientMessage = Extract<
  ClientToServerMessage,
  { type: 'sfu-publish' | 'sfu-unpublish' | 'sfu-subscribe' | 'sfu-renegotiate' | 'sfu-unsubscribe' }
>;
type SfuReply = (result: Omit<SfuResultMessage, 'type' | 'requestId'>) => void;

// A client runs at most two SFU calls at once (its publisher and subscriber queues).
const SFU_MAX_IN_FLIGHT = 2;

function sfuTrackList(peer: PeerAttachment): { role: SfuTrackRole; trackName: string }[] {
  return (peer.sfu?.tracks ?? []).map((t) => ({ role: t.role, trackName: t.name }));
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

  /** RPC for ServerPresence (presence.ts): who is in this room right now. Live sockets only, so a
   * room whose connections died with a deploy reads empty. `excludePeerId`: a peer whose socket is
   * closing but still listed. */
  async presence(excludePeerId?: string): Promise<PresencePeer[]> {
    return this.livePeers()
      .filter((p) => p.peerId !== excludePeerId)
      .map((p) => ({ userId: p.userId, displayName: p.displayName }));
  }

  /** Pushes this room's current list to its server's ServerPresence. Best-effort: presence is a
   * convenience, a failure here must never affect the call itself. */
  private async notifyPresence(excludePeerId?: string): Promise<void> {
    try {
      const serverId = await this.ctx.storage.get<string>('serverId');
      if (!serverId) return;
      const presence = this.env.PRESENCE.get(this.env.PRESENCE.idFromName(serverId));
      await presence.roomChanged(await this.getRoomId(), await this.presence(excludePeerId));
    } catch (error) {
      console.error('signaling: presence notify failed', error);
    }
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

    this.touch(ws);
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
        // Sweep here rather than on a timer: a Durable Object Alarm is already spoken for by host
        // migration (one alarm per object), and a room with no live peer pinging has nobody left
        // to see a ghost anyway.
        await this.dropSilentPeers(ws);
        break;
      case 'status-changed':
        await this.handleStatusChanged(ws, message.status);
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
      case 'music-share-changed':
        await this.handleMusicShareChanged(ws, message.isSharing);
        break;
      case 'avatar-changed':
        await this.handleAvatarChanged(ws);
        break;
      case 'server-icon-changed':
        await this.handleServerIconChanged(ws, message.serverId);
        break;
      case 'sfu-publish':
      case 'sfu-unpublish':
      case 'sfu-subscribe':
      case 'sfu-renegotiate':
      case 'sfu-unsubscribe':
        await this.handleSfu(ws, message);
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
    let serverMediaMode: string | undefined;
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
      serverMediaMode = server.media_mode;
      const userRecord = await usersRepo.findById(this.env, verifiedUserId);
      verifiedDisplayName = userRecord?.display_name ?? null;
    } else if (this.env.ALLOW_UNAUTHENTICATED_ROOMS === 'true') {
      userId = message.userId;
    } else {
      this.send(ws, { type: 'join-rejected', roomId: message.roomId, reason: 'unauthorized' });
      return;
    }

    // Checked before the duplicate handling below touches any existing socket: refusing after that
    // would leave this user's old entry cleared without a peer-left (a ghost for everyone else).
    // "Empty" ignores this same user's older connection, which is about to be replaced.
    const mediaMode = await this.resolveMediaMode(
      this.livePeers().every((p) => p.userId === userId),
      serverMediaMode
    );
    if (mediaMode === 'sfu' && message.sfuCapable !== true) {
      this.send(ws, { type: 'join-rejected', roomId: message.roomId, reason: 'update-required' });
      return;
    }

    // [Bug real corrigido, 2026-08-30, achado pelo Mozar] A mesma conta podia acabar com dois
    // peers ao mesmo tempo na sala — nada aqui checava userId duplicado, só a capacidade total.
    // Reproduzido de verdade quando uma conexão morre sem um fechamento limpo de socket (processo
    // derrubado à força, crash, queda de rede) e a reconexão da mesma conta chega antes do runtime
    // perceber que a conexão antiga sumiu (não existe watchdog de heartbeat perdido — só reage a
    // um fechamento real, ver handleDisconnect). Toda conexão já existente com o mesmo userId é,
    // por definição, mais antiga que a que está entrando agora — derrubada aqui antes de montar o
    // roster que vai pra esse peer novo, reaproveitando handleDisconnect (broadcast de peer-left +
    // migração de host se o peer derrubado era o host) pra não duplicar essa lógica.
    //
    // [Refinado, 2026-09-30, pedido do Mozar] Derrubar + recriar ainda deixava a reconexão visível
    // como peer-left + peer-joined (duas entradas por um instante, sons de sair/entrar, e migração
    // de host se o peer antigo era o host). Agora o PRIMEIRO peer existente com esse userId é
    // reaproveitado: mesmo peerId, mesmo joinedAt (mantém o papel de host e a ordem de migração),
    // só a conexão e o displayName passam a ser os da nova — os outros recebem `peer-rejoined` em
    // vez de peer-left/peer-joined. Qualquer duplicata além da primeira (não deveria existir) cai
    // no caminho antigo de derrubar.
    const [reused, ...stale] = this.livePeers().filter((p) => p.userId === userId);
    for (const duplicate of stale) {
      const duplicateWs = this.findSocketByPeerId(duplicate.peerId);
      if (!duplicateWs) continue;
      await this.handleDisconnect(duplicateWs);
      try {
        duplicateWs.close(1000, 'Reconectado em outra sessão');
      } catch {
        // já fechando/fechado por conta própria — sem problema, handleDisconnect já rodou
      }
    }
    if (reused) {
      const oldWs = this.findSocketByPeerId(reused.peerId);
      if (oldWs) {
        // Attachment limpo ANTES do close: webSocketClose -> handleDisconnect vê null e não faz
        // broadcast de peer-left nem migra o host para um peer que continua na sala.
        oldWs.serializeAttachment(null);
        try {
          oldWs.close(1000, 'Reconectado em outra sessão');
        } catch {
          // já fechando/fechado — o attachment já foi limpo, nada mais a fazer
        }
      }
    }

    const existingPeers = this.livePeers();
    if (existingPeers.length >= ROOM_CAP) {
      this.send(ws, { type: 'join-rejected', roomId: message.roomId, reason: 'room-full' });
      return;
    }

    // Fora do ramo autenticado (só o bypass ALLOW_UNAUTHENTICATED_ROOMS, nunca produção — ver
    // acima), não existe um nickname de D1 pra confiar, então cai de volta pro que a mensagem
    // mandou — mesmo trim/cap defensivo de sempre, roomManager.ts tinha o mesmo padrão.
    // Which server's ServerPresence to tell about this room (notifyPresence). Authenticated joins
    // already proved above that this room belongs to message.serverId.
    if ((await this.ctx.storage.get<string>('serverId')) !== message.serverId) {
      await this.ctx.storage.put('serverId', message.serverId);
    }

    const safeDisplayName = (verifiedDisplayName ?? message.displayName).trim().slice(0, 60) || 'Peer';
    const safeUserId = userId.trim().slice(0, 100) || crypto.randomUUID();
    const peer: PeerAttachment = {
      peerId: reused?.peerId ?? crypto.randomUUID(),
      userId: safeUserId,
      displayName: safeDisplayName,
      joinedAt: reused?.joinedAt ?? Date.now(),
      lastSeenAt: Date.now(),
      status: message.status ?? 'online'
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
      peers: existingPeers.map((p) => ({
        peerId: p.peerId,
        displayName: p.displayName,
        userId: p.userId,
        status: p.status ?? 'online'
      })),
      mediaMode
    });
    if (mediaMode === 'sfu') {
      for (const p of existingPeers) {
        if (p.sfu?.tracks?.length) {
          this.send(ws, { type: 'peer-sfu-tracks', roomId: message.roomId, peerId: p.peerId, tracks: sfuTrackList(p) });
        }
      }
    }

    this.broadcast(
      {
        type: reused ? 'peer-rejoined' : 'peer-joined',
        roomId: message.roomId,
        peerId: peer.peerId,
        displayName: safeDisplayName,
        userId: safeUserId,
        status: peer.status ?? 'online'
      },
      peer.peerId
    );
    void this.notifyPresence();
  }

  private async handleStatusChanged(ws: WebSocket, status: PresenceStatus): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;
    ws.serializeAttachment({ ...peer, status });
    const roomId = await this.getRoomId();
    this.broadcast({ type: 'peer-status-changed', roomId, peerId: peer.peerId, status }, peer.peerId);
  }

  private touch(ws: WebSocket): void {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (peer) ws.serializeAttachment({ ...peer, lastSeenAt: Date.now() });
  }

  /** Removes every peer (except `except`, the one that just pinged) that has been silent longer
   * than PEER_TIMEOUT_MS — same peer-left broadcast + host migration as a real disconnect. The
   * attachment is cleared BEFORE the first await so two pings interleaving at an await can't both
   * drop the same peer, and so the late webSocketClose/Error for it (if the runtime ever
   * delivers one) finds nothing left to announce. */
  private async dropSilentPeers(except: WebSocket): Promise<void> {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const peer = ws.deserializeAttachment() as PeerAttachment | null;
      if (!peer || (peer.lastSeenAt ?? peer.joinedAt) > cutoff) continue;
      ws.serializeAttachment(null);
      await this.handleDisconnect(ws, peer);
      try {
        ws.close(1001, 'Sem resposta');
      } catch {
        // already closing/closed — the peer was already announced as left above
      }
    }
  }

  private findSocketByPeerId(peerId: string): WebSocket | undefined {
    return this.ctx
      .getWebSockets()
      .find((s) => (s.deserializeAttachment() as PeerAttachment | null)?.peerId === peerId);
  }

  private async handleDisconnect(ws: WebSocket, known?: PeerAttachment): Promise<void> {
    const peer = known ?? (ws.deserializeAttachment() as PeerAttachment | null);
    if (!peer) return;

    const roomId = await this.getRoomId();
    this.broadcast({ type: 'peer-left', roomId, peerId: peer.peerId }, peer.peerId);
    void this.notifyPresence(peer.peerId);

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

  private async handleMusicShareChanged(ws: WebSocket, isSharing: boolean): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;
    const roomId = await this.getRoomId();
    this.broadcast({ type: 'peer-music-share-changed', roomId, peerId: peer.peerId, isSharing }, peer.peerId);
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

  // ---- SFU mode (messages.ts "SFU mode", src/sfu.ts) --------------------------------------------

  /** The first peer into an empty room fixes its media mode from the server's setting; everyone
   * after gets the stored one, so a room never mixes modes. 'sfu' also needs the SFU secrets. */
  private async resolveMediaMode(roomIsEmpty: boolean, serverMediaMode: string | undefined): Promise<MediaMode> {
    if (!roomIsEmpty) return (await this.ctx.storage.get<MediaMode>('mediaMode')) ?? 'mesh';
    const override = this.env.MEDIA_MODE_OVERRIDE;
    const wanted = override === 'sfu' || override === 'mesh' ? override : serverMediaMode;
    const mode: MediaMode = wanted === 'sfu' && sfu.sfuConfigured(this.env) ? 'sfu' : 'mesh';
    await this.ctx.storage.put('mediaMode', mode);
    return mode;
  }

  /** In-flight SFU calls per socket, in memory only (hibernation never happens mid-call). */
  private sfuInFlight = new Map<WebSocket, number>();

  private async handleSfu(ws: WebSocket, message: SfuClientMessage): Promise<void> {
    const peer = ws.deserializeAttachment() as PeerAttachment | null;
    if (!peer) return;
    const reply: SfuReply = (result) => this.send(ws, { type: 'sfu-result', requestId: message.requestId, ...result });
    if ((await this.ctx.storage.get<MediaMode>('mediaMode')) !== 'sfu') return reply({ ok: false, error: 'not-sfu-room' });
    const inFlight = this.sfuInFlight.get(ws) ?? 0;
    if (inFlight >= SFU_MAX_IN_FLIGHT) return reply({ ok: false, error: 'busy' });
    this.sfuInFlight.set(ws, inFlight + 1);
    try {
      await this.runSfu(ws, peer, message, reply);
    } catch (error) {
      reply({ ok: false, error: error instanceof sfu.SfuApiError ? error.code : 'internal' });
      await logError(this.env, error, {
        source: 'do',
        roomId: await this.getRoomId(),
        userId: peer.userId,
        peerId: peer.peerId,
        kind: message.type
      });
    } finally {
      const left = (this.sfuInFlight.get(ws) ?? 1) - 1;
      if (left > 0) this.sfuInFlight.set(ws, left);
      else this.sfuInFlight.delete(ws);
    }
  }

  private async runSfu(ws: WebSocket, peer: PeerAttachment, message: SfuClientMessage, reply: SfuReply): Promise<void> {
    const state = peer.sfu ?? {};
    switch (message.type) {
      case 'sfu-publish': {
        const kept = message.fresh ? [] : (state.tracks ?? []);
        if (message.tracks.some((t) => kept.some((k) => k.role === t.role))) {
          return reply({ ok: false, error: 'role-already-published' });
        }
        const pub = (!message.fresh && state.pub) || (await sfu.createSession(this.env));
        const named = message.tracks.map((t) => ({ role: t.role, mid: t.mid, name: `${t.role}-${crypto.randomUUID().slice(0, 8)}` }));
        const result = await sfu.pushTracks(this.env, pub, message.sdp, named.map((t) => ({ mid: t.mid, trackName: t.name })));
        const failed = new Set((result.tracks ?? []).filter((t) => t.errorCode).flatMap((t) => [t.trackName, t.mid]));
        const saved = this.saveSfu(ws, peer.peerId, (s) => ({
          ...s,
          pub,
          tracks: [...(message.fresh ? [] : (s.tracks ?? [])), ...named.filter((t) => !failed.has(t.name) && !failed.has(t.mid))]
        }));
        if (!saved) return;
        reply({
          ok: true,
          sdp: result.sessionDescription?.sdp,
          tracks: (result.tracks ?? []).map((t) => ({ trackName: t.trackName ?? '', mid: t.mid, error: t.errorCode }))
        });
        await this.announceSfuTracks(saved);
        return;
      }
      case 'sfu-unpublish': {
        const own = new Set((state.tracks ?? []).map((t) => t.mid));
        if (!state.pub || !message.mids.every((mid) => own.has(mid))) return reply({ ok: false, error: 'unknown-track' });
        const result = await sfu.closeTracks(this.env, state.pub, message.mids, message.sdp);
        const closing = new Set(message.mids);
        const saved = this.saveSfu(ws, peer.peerId, (s) => ({ ...s, tracks: (s.tracks ?? []).filter((t) => !closing.has(t.mid)) }));
        if (!saved) return;
        reply({ ok: true, sdp: result.sessionDescription?.sdp });
        await this.announceSfuTracks(saved);
        return;
      }
      case 'sfu-subscribe': {
        // The client names peers and track names only; session ids come from this room's own state.
        const resolved = sfu.resolvePulls(message.tracks, this.livePeers(), peer.peerId);
        const valid = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
        const notFound = (t: { peerId: string; trackName: string }) => ({ ...t, error: 'not-found' });
        if (valid.length === 0) return reply({ ok: true, tracks: message.tracks.map(notFound) });
        const sub = (!message.fresh && state.sub) || (await sfu.createSession(this.env));
        const result = await sfu.pullTracks(this.env, sub, valid.map((v) => ({ sessionId: v.sessionId, trackName: v.trackName })));
        if (!this.saveSfu(ws, peer.peerId, (s) => ({ ...s, sub }))) return;
        reply({
          ok: true,
          sdp: result.sessionDescription?.sdp,
          tracks: message.tracks.map((t, i) => {
            const target = resolved[i];
            if (!target) return notFound(t);
            const pulled = result.tracks?.find(
              (r) => r.trackName === target.trackName && (!r.sessionId || r.sessionId === target.sessionId)
            );
            return { ...t, mid: pulled?.mid, error: pulled ? pulled.errorCode : 'missing' };
          })
        });
        return;
      }
      case 'sfu-renegotiate':
        if (!state.sub) return reply({ ok: false, error: 'no-session' });
        await sfu.renegotiate(this.env, state.sub, message.sdp);
        return reply({ ok: true });
      case 'sfu-unsubscribe':
        if (state.sub) await sfu.closeTracks(this.env, state.sub, message.mids);
        return reply({ ok: true });
    }
  }

  /** Re-reads the attachment after the API await (another message may have changed or cleared it)
   * and merges the new SFU state. Null when this peer left meanwhile: nothing to save or announce. */
  private saveSfu(ws: WebSocket, peerId: string, update: (state: SfuPeerState) => SfuPeerState): PeerAttachment | null {
    const current = ws.deserializeAttachment() as PeerAttachment | null;
    if (!current || current.peerId !== peerId) return null;
    const next: PeerAttachment = { ...current, sfu: update(current.sfu ?? {}) };
    ws.serializeAttachment(next);
    return next;
  }

  private async announceSfuTracks(peer: PeerAttachment): Promise<void> {
    const roomId = await this.getRoomId();
    this.broadcast({ type: 'peer-sfu-tracks', roomId, peerId: peer.peerId, tracks: sfuTrackList(peer) }, peer.peerId);
  }

  // ---- low-level socket helpers -----------------------------------------------------------------

  /** The durable source of truth for "who's in the room" — never duplicated into ctx.storage. */
  private livePeers(): PeerAttachment[] {
    return this.ctx
      .getWebSockets()
      .map((s) => s.deserializeAttachment() as PeerAttachment | null)
      .filter((p): p is PeerAttachment => Boolean(p)); // null/undefined: not joined yet, or cleared on rejoin
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
