import type { ClientToServerMessage, PresenceStatus, ServerToClientMessage } from '@concord/shared';

export type SignalingStatus = 'connecting' | 'connected' | 'disconnected';

// Waits before each reconnect attempt (~31s in total) — after the last one fails the client gives
// up and reports 'disconnected', which is what ServerListPage turns into "leave the room".
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000];

// A server-side close with this code is deliberate ("Reconectado em outra sessão" — the same
// account joined from somewhere else, see room.ts) — reconnecting would just kick that other
// session back out and the two would fight forever.
const DELIBERATE_CLOSE_CODE = 1000;

/**
 * Thin WebSocket wrapper around the signaling protocol. An unexpected drop is retried with a
 * short backoff (RECONNECT_DELAYS_MS) and re-sends join-room on each new socket — the server
 * recognizes the same userId still in the room and just swaps in the new connection's data (same
 * peerId, no duplicate participant, see room.ts handleJoinRoom) — instead of immediately being
 * treated as leaving the room (see useRoomConnection).
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private messageHandlers = new Set<(message: ServerToClientMessage) => void>();
  private statusHandlers = new Set<(status: SignalingStatus) => void>();
  // [Bug corrigido, investigação de conectividade 2026-08-27] send() silenciosamente descartava
  // qualquer mensagem chamada enquanto o socket ainda não estava OPEN — sem fila, sem aviso, sem
  // erro. offer/answer/join-room nunca batiam nisso na prática (só disparam em resposta a uma
  // mensagem já recebida, o que já implica socket aberto), mas 'ice-candidate' é diferente:
  // pc.onicecandidate pode disparar em qualquer momento depois que a negociação começa, inclusive
  // bem cedo — se isso coincidir com o socket ainda em CONNECTING (ou reaberto depois de uma
  // reconexão), o candidato se perde pra sempre, sem nunca ser reenviado. Dado real que motivou a
  // correção: getStats() na chamada real mostrando candidatos locais reunidos perfeitamente dos
  // dois lados (inclusive srflx) mas "candidatos remotos recebidos: NENHUM" — o candidato nunca
  // chega no destino porque nunca chega a sair da origem. Enfileira em vez de descartar, esvazia
  // assim que o socket abre.
  private pendingSends: ClientToServerMessage[] = [];
  private connectArgs: Parameters<SignalingClient['connect']> | null = null;
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // The server keeps no per-peer state for this — a rejoin starts from "not muted" on every other
  // client unless it's told again. Only mic-state needs replaying: screen/music tracks arrive
  // again through the renegotiation that follows the rejoin, avatars get re-requested by the
  // receivers themselves on peer-rejoined.
  private lastMicState: ClientToServerMessage | null = null;
  // Always the latest status the user picked: sent inside every join-room (first join and every
  // automatic reconnect), so the room never comes back showing a stale one.
  private presenceStatus: PresenceStatus = 'online';

  connect(
    url: string,
    roomId: string,
    serverId: string,
    displayName: string,
    userId: string,
    sessionToken: string,
    status: PresenceStatus = 'online'
  ): void {
    this.presenceStatus = status;
    this.connectArgs = [url, roomId, serverId, displayName, userId, sessionToken];
    this.manualClose = false;
    this.reconnectAttempt = 0;
    this.pendingSends = [];
    this.open(false);
  }

  private open(isReconnect: boolean): void {
    if (!this.connectArgs) return;
    const [url, roomId, serverId, displayName, userId, sessionToken] = this.connectArgs;
    this.setStatus('connecting');
    // roomId travels on the connection URL itself, not just inside the join-room message below —
    // needed so a Cloudflare Durable Object signaling backend (packages/signaling-worker) can
    // route the WebSocket upgrade to the right per-room object before any message is received.
    // The Node signaling server (packages/server) ignores query params entirely, so this is a
    // no-op against that backend.
    const connectUrl = new URL(url);
    connectUrl.searchParams.set('roomId', roomId);
    connectUrl.searchParams.set('serverId', serverId);
    const ws = new WebSocket(connectUrl.toString());
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.setStatus('connected');
      this.send({
        type: 'join-room',
        roomId,
        serverId,
        displayName,
        userId,
        sessionToken,
        status: this.presenceStatus,
        sfuCapable: true
      });
      if (isReconnect && this.lastMicState) this.send(this.lastMicState);
      const queued = this.pendingSends;
      this.pendingSends = [];
      for (const message of queued) this.send(message);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let message: ServerToClientMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const handler of this.messageHandlers) handler(message);
    };

    // onerror always precedes an onclose on a failed/dropped socket — reacting to both would
    // schedule two retries for one drop, so only onclose drives reconnection.
    ws.onclose = (event) => this.handleClose(ws, event.code);
  }

  private handleClose(ws: WebSocket, code: number): void {
    if (this.ws !== ws) return; // stale socket from an attempt already replaced/closed on purpose
    if (this.manualClose || code === DELIBERATE_CLOSE_CODE || this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.setStatus('disconnected');
      return;
    }
    // 'connecting' (not 'disconnected') while retrying — 'disconnected' is what makes
    // ServerListPage drop the user out of the room, which is exactly what this avoids.
    this.setStatus('connecting');
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt++];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) this.open(true);
    }, delay);
  }

  send(message: ClientToServerMessage): void {
    if (message.type === 'mic-state') this.lastMicState = message;
    if (message.type === 'status-changed') this.presenceStatus = message.status;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    // CONNECTING (not yet OPEN) — queue for onopen's flush, above. CLOSING/CLOSED/no socket at
    // all — genuinely gone (or between reconnect attempts), drop it rather than queue forever.
    // A ping is worthless once stale, so it's never queued either (a burst of them right after
    // reconnecting would just be noise for the server's liveness check). SFU requests aren't either:
    // after a reconnect the 'room-joined' that follows starts a new SfuMedia with fresh sessions, so
    // a queued one would only open an orphan session at the SFU.
    if (this.ws?.readyState === WebSocket.CONNECTING && message.type !== 'ping' && !message.type.startsWith('sfu-')) {
      this.pendingSends.push(message);
    }
  }

  onMessage(handler: (message: ServerToClientMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (status: SignalingStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private setStatus(status: SignalingStatus): void {
    for (const handler of this.statusHandlers) handler(status);
  }
}
