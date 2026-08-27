import type { WebSocket } from 'ws';
import type { ClientToServerMessage } from '@concord/shared';
import {
  handleAvatarChanged,
  handleCandidateConfirm,
  handleDeviceSwitched,
  handleDisconnect,
  handleHeartbeat,
  handleMicState,
  handleScreenShareChanged,
  joinRoom,
  relay
} from '../rooms/roomManager.js';
import { logError } from '../logging/errorLog.js';

function isStr(value: unknown, maxLen: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen;
}

/**
 * [Achado de segurança] JSON.parse() alone only guarantees valid JSON, not that fields are
 * strings of a sane type/size — without this, a misbehaving or hostile client could send e.g. a
 * multi-megabyte `sdp`/`candidate` string (relayed verbatim to another peer's connection) or a
 * non-string field that blows up downstream code that assumes strings (roomManager.ts, and
 * MeshManager on the receiving peer's end). Caps below are generous headroom above any real
 * SDP/ICE-candidate/JWT this app ever produces, not tuned tightly — this is a shape/size guard,
 * not business validation (roomManager.ts still does its own checks on top of this).
 */
function validateClientMessage(raw: unknown): ClientToServerMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;

  switch (m.type) {
    case 'join-room':
      return isStr(m.roomId, 200) &&
        isStr(m.serverId, 200) &&
        isStr(m.displayName, 200) &&
        isStr(m.userId, 200) &&
        isStr(m.sessionToken, 4000)
        ? (m as unknown as ClientToServerMessage)
        : null;
    case 'sdp-offer':
    case 'sdp-answer':
      return isStr(m.targetPeerId, 200) && isStr(m.sdp, 65536) ? (m as unknown as ClientToServerMessage) : null;
    case 'ice-candidate':
      return isStr(m.targetPeerId, 200) && isStr(m.candidate, 4000) ? (m as unknown as ClientToServerMessage) : null;
    case 'host-heartbeat':
      return isStr(m.roomId, 200) && typeof m.epoch === 'number' ? (m as unknown as ClientToServerMessage) : null;
    case 'host-candidate-confirm':
      return isStr(m.roomId, 200) && typeof m.epoch === 'number' ? (m as unknown as ClientToServerMessage) : null;
    case 'ping':
      return isStr(m.nonce, 100) ? (m as unknown as ClientToServerMessage) : null;
    case 'device-switched':
      return m.kind === 'mic' || m.kind === 'speaker' ? (m as unknown as ClientToServerMessage) : null;
    case 'mic-state':
      return typeof m.isMicMuted === 'boolean' && typeof m.isDeafened === 'boolean'
        ? (m as unknown as ClientToServerMessage)
        : null;
    case 'screen-share-changed':
      return typeof m.isSharing === 'boolean' ? (m as unknown as ClientToServerMessage) : null;
    case 'avatar-changed':
      return m as unknown as ClientToServerMessage;
    default:
      return null;
  }
}

export function handleConnection(socket: WebSocket): void {
  socket.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const message = validateClientMessage(parsed);
    if (!message) return;

    try {
      switch (message.type) {
        case 'join-room':
          void joinRoom(socket, message.roomId, message.serverId, message.displayName, message.userId, message.sessionToken).catch(
            (error) => {
              void logError(error, { source: 'ws', route: message.type, roomId: message.roomId });
            }
          );
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
        case 'ping':
          socket.send(JSON.stringify({ type: 'pong', nonce: message.nonce }));
          break;
        case 'device-switched':
          handleDeviceSwitched(socket, message.kind);
          break;
        case 'mic-state':
          handleMicState(socket, message.isMicMuted, message.isDeafened);
          break;
        case 'screen-share-changed':
          handleScreenShareChanged(socket, message.isSharing);
          break;
        case 'avatar-changed':
          handleAvatarChanged(socket);
          break;
      }
    } catch (error) {
      void logError(error, {
        source: 'ws',
        route: message.type,
        roomId: 'roomId' in message ? message.roomId : undefined
      });
    }
  });

  socket.on('close', () => handleDisconnect(socket));
}
