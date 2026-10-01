import type { ClientToServerMessage } from '@concord/shared';

/** Same size-guard rationale as packages/server/src/websocket/connectionHandler.ts
 * validateClientMessage — generous headroom above any real payload this app produces, a
 * shape/size guard against a misbehaving/hostile client, not business validation. */
function isStr(value: unknown, maxLen: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen;
}

function isStatus(value: unknown): boolean {
  return value === 'online' || value === 'busy' || value === 'unavailable' || value === 'offline';
}

export function validateClientMessage(raw: unknown): ClientToServerMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;

  switch (m.type) {
    case 'join-room':
      return isStr(m.roomId, 200) &&
        isStr(m.serverId, 200) &&
        isStr(m.displayName, 200) &&
        isStr(m.userId, 200) &&
        isStr(m.sessionToken, 4000) &&
        (m.status === undefined || isStatus(m.status))
        ? (m as unknown as ClientToServerMessage)
        : null;
    case 'status-changed':
      return isStatus(m.status) ? (m as unknown as ClientToServerMessage) : null;
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
    case 'music-share-changed':
      return typeof m.isSharing === 'boolean' ? (m as unknown as ClientToServerMessage) : null;
    case 'avatar-changed':
      return m as unknown as ClientToServerMessage;
    case 'peer-mute-status':
      return isStr(m.targetPeerId, 200) && typeof m.isMuted === 'boolean'
        ? (m as unknown as ClientToServerMessage)
        : null;
    case 'server-icon-changed':
      return isStr(m.serverId, 200) ? (m as unknown as ClientToServerMessage) : null;
    default:
      return null;
  }
}
