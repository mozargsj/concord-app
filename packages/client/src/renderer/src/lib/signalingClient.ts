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

  connect(url: string, roomId: string, displayName: string, userId: string): void {
    this.setStatus('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus('connected');
      this.send({ type: 'join-room', roomId, displayName, userId });
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
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
