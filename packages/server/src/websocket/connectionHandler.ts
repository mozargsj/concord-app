import type { WebSocket } from 'ws';
import type { ClientToServerMessage } from '@concord/shared';

export function handleConnection(socket: WebSocket): void {
  socket.on('message', (raw) => {
    let message: ClientToServerMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Signaling protocol (SDP/ICE relay, host election) is not wired yet —
    // this is the entry point where each message type will be dispatched.
    void message;
  });
}
