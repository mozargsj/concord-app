import type { WebSocket } from 'ws';
import type { ClientToServerMessage } from '@concord/shared';
import {
  handleCandidateConfirm,
  handleDisconnect,
  handleHeartbeat,
  joinRoom,
  relay
} from '../rooms/roomManager.js';

export function handleConnection(socket: WebSocket): void {
  socket.on('message', (raw) => {
    let message: ClientToServerMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (message.type) {
      case 'join-room':
        joinRoom(socket, message.roomId);
        break;
      case 'sdp-offer':
      case 'sdp-answer':
      case 'ice-candidate':
        relay(socket, message);
        break;
      case 'host-heartbeat':
        handleHeartbeat(socket, message.roomId, message.epoch);
        break;
      case 'host-candidate-confirm':
        handleCandidateConfirm(socket, message.roomId, message.epoch);
        break;
    }
  });

  socket.on('close', () => handleDisconnect(socket));
}
