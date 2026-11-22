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

const SFU_ROLES = new Set(['mic', 'camera', 'screenVideo', 'screenAudio', 'musicAudio']);
// A subscriber SDP grows one m-line per pulled track; stays under the room's 128 KiB message cap.
const SFU_SDP_MAX = 120_000;
const MID_MAX = 32;

function isList(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.length <= max;
}

function isMidList(value: unknown, max: number): boolean {
  return isList(value, max) && value.every((mid) => isStr(mid, MID_MAX));
}

function isSfuPublishTracks(value: unknown): boolean {
  if (!isList(value, SFU_ROLES.size)) return false;
  const tracks = value as { mid?: unknown; role?: unknown }[];
  return (
    tracks.every((t) => t && isStr(t.mid, MID_MAX) && SFU_ROLES.has(t.role as string)) &&
    new Set(tracks.map((t) => t.role)).size === tracks.length
  );
}

function isSfuPullTracks(value: unknown): boolean {
  return (
    isList(value, 64) &&
    (value as { peerId?: unknown; trackName?: unknown }[]).every((t) => t && isStr(t.peerId, 200) && isStr(t.trackName, 64))
  );
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
        (m.status === undefined || isStatus(m.status)) &&
        (m.sfuCapable === undefined || typeof m.sfuCapable === 'boolean')
        ? (m as unknown as ClientToServerMessage)
        : null;
    case 'sfu-publish':
      return isStr(m.requestId, 64) && typeof m.fresh === 'boolean' && isStr(m.sdp, SFU_SDP_MAX) && isSfuPublishTracks(m.tracks)
        ? (m as unknown as ClientToServerMessage)
        : null;
    case 'sfu-unpublish':
      return isStr(m.requestId, 64) && isStr(m.sdp, SFU_SDP_MAX) && isMidList(m.mids, SFU_ROLES.size)
        ? (m as unknown as ClientToServerMessage)
        : null;
    case 'sfu-subscribe':
      return isStr(m.requestId, 64) && typeof m.fresh === 'boolean' && isSfuPullTracks(m.tracks)
        ? (m as unknown as ClientToServerMessage)
        : null;
    case 'sfu-renegotiate':
      return isStr(m.requestId, 64) && isStr(m.sdp, SFU_SDP_MAX) ? (m as unknown as ClientToServerMessage) : null;
    case 'sfu-unsubscribe':
      return isStr(m.requestId, 64) && isMidList(m.mids, 64) ? (m as unknown as ClientToServerMessage) : null;
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
