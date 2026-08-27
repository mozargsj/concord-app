import type { ClientToServerMessage, ServerToClientMessage } from '@concord/shared';

export type SignalingStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * Thin WebSocket wrapper around the signaling protocol. No auto-reconnect —
 * an unexpected drop is treated the same as leaving the room (see useRoomConnection),
 * kept simple for the alpha phase per decisions.md.
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

  connect(url: string, roomId: string, displayName: string, userId: string): void {
    this.setStatus('connecting');
    this.pendingSends = [];
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus('connected');
      this.send({ type: 'join-room', roomId, displayName, userId });
      const queued = this.pendingSends;
      this.pendingSends = [];
      for (const message of queued) this.send(message);
    };

    ws.onmessage = (event) => {
      let message: ServerToClientMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const handler of this.messageHandlers) handler(message);
    };

    ws.onclose = () => this.setStatus('disconnected');
    ws.onerror = () => this.setStatus('disconnected');
  }

  send(message: ClientToServerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    // CONNECTING (not yet OPEN) — queue for onopen's flush, above. CLOSING/CLOSED/no socket at
    // all — genuinely gone, no reconnect exists to eventually flush this, so drop it rather than
    // queue forever (matches the existing "no auto-reconnect" design, decisions.md).
    if (this.ws?.readyState === WebSocket.CONNECTING) this.pendingSends.push(message);
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
    this.ws?.close();
    this.ws = null;
  }

  private setStatus(status: SignalingStatus): void {
    for (const handler of this.statusHandlers) handler(status);
  }
}
