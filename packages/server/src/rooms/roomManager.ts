import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type {
  DeviceKind,
  IceCandidateMessage,
  SdpAnswerMessage,
  SdpOfferMessage,
  ServerToClientMessage
} from '@concord/shared';

const ROOM_CAP = 10;
const CANDIDATE_BATCH_SIZE = 3;
const CONFIRM_TIMEOUT_MS = 2000;

interface Peer {
  id: string;
  socket: WebSocket;
  roomId: string;
  joinedAt: number;
  displayName: string;
  userId: string;
}

interface PendingMigration {
  epoch: number;
  batch: string[];
  timer: ReturnType<typeof setTimeout>;
}

interface Room {
  id: string;
  peers: Map<string, Peer>;
  hostPeerId: string | null;
  epoch: number;
  pendingMigration: PendingMigration | null;
}

const rooms = new Map<string, Room>();
const peersBySocket = new WeakMap<WebSocket, Peer>();

function send(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room: Room, message: ServerToClientMessage, excludePeerId?: string): void {
  for (const peer of room.peers.values()) {
    if (peer.id !== excludePeerId) send(peer.socket, message);
  }
}

export function joinRoom(socket: WebSocket, roomId: string, displayName: string, userId: string): void {
  if (peersBySocket.has(socket)) return; // one room per socket at a time

  let room = rooms.get(roomId);
  if (!room) {
    room = { id: roomId, peers: new Map(), hostPeerId: null, epoch: 0, pendingMigration: null };
    rooms.set(roomId, room);
  }

  if (room.peers.size >= ROOM_CAP) {
    send(socket, { type: 'join-rejected', roomId, reason: 'room-full' });
    return;
  }

  const existingPeers = [...room.peers.values()];
  // displayName/userId come from an untrusted client and are rebroadcast to strangers in the
  // room — trim/cap rather than trusting verbatim. userId lets peers attribute a shared-room
  // participant to a persistent account (e.g. to fetch their avatar over the mesh's own data
  // channel) — it's not used for any authorization decision, so a spoofed value only misleads
  // other clients' local caches, never grants access to anything.
  const safeDisplayName = displayName.trim().slice(0, 60) || 'Peer';
  const safeUserId = userId.trim().slice(0, 100) || randomUUID();
  const peer: Peer = {
    id: randomUUID(),
    socket,
    roomId,
    joinedAt: Date.now(),
    displayName: safeDisplayName,
    userId: safeUserId
  };
  room.peers.set(peer.id, peer);
  peersBySocket.set(socket, peer);

  if (room.hostPeerId === null) {
    room.hostPeerId = peer.id; // host = first peer to connect
  }

  send(socket, {
    type: 'room-joined',
    roomId,
    peerId: peer.id,
    hostPeerId: room.hostPeerId,
    epoch: room.epoch,
    peers: existingPeers.map((p) => ({ peerId: p.id, displayName: p.displayName, userId: p.userId }))
  });

  broadcast(
    room,
    { type: 'peer-joined', roomId, peerId: peer.id, displayName: safeDisplayName, userId: safeUserId },
    peer.id
  );
}

export function relay(
  socket: WebSocket,
  message: SdpOfferMessage | SdpAnswerMessage | IceCandidateMessage
): void {
  const sender = peersBySocket.get(socket);
  if (!sender) return;

  const room = rooms.get(sender.roomId);
  const target = room?.peers.get(message.targetPeerId);
  if (!target) return;

  send(target.socket, { ...message, fromPeerId: sender.id });
}

export function handleHeartbeat(socket: WebSocket, roomId: string, epoch: number): void {
  // Recorded for a future missed-heartbeat watchdog once the client actually sends these —
  // migration today is only triggered by a real disconnect (see handleDisconnect below).
  void socket;
  void roomId;
  void epoch;
}

export function handleCandidateConfirm(socket: WebSocket, roomId: string, epoch: number): void {
  const peer = peersBySocket.get(socket);
  const room = rooms.get(roomId);
  if (!peer || !room || !room.pendingMigration) return;
  if (room.pendingMigration.epoch !== epoch) return; // stale confirmation from a superseded round
  if (!room.pendingMigration.batch.includes(peer.id)) return;

  clearTimeout(room.pendingMigration.timer);
  room.pendingMigration = null;
  room.hostPeerId = peer.id;
  broadcast(room, { type: 'host-changed', roomId, hostPeerId: peer.id, epoch });
}

export function handleDeviceSwitched(socket: WebSocket, kind: DeviceKind): void {
  const peer = peersBySocket.get(socket);
  if (!peer) return;
  const room = rooms.get(peer.roomId);
  if (!room) return;
  // The switcher already plays the sound locally, no round-trip needed for their own feedback.
  broadcast(room, { type: 'peer-device-switched', roomId: room.id, peerId: peer.id, kind }, peer.id);
}

export function handleMicState(socket: WebSocket, isMicMuted: boolean, isDeafened: boolean): void {
  const peer = peersBySocket.get(socket);
  if (!peer) return;
  const room = rooms.get(peer.roomId);
  if (!room) return;
  // Not excluding the sender here (unlike peer-device-switched) — this drives a persistent
  // UI indicator next to the sender's own name too, on every other client, not a one-off sound.
  broadcast(room, { type: 'peer-mic-state', roomId: room.id, peerId: peer.id, isMicMuted, isDeafened });
}

export function handleScreenShareChanged(socket: WebSocket, isSharing: boolean): void {
  const peer = peersBySocket.get(socket);
  if (!peer) return;
  const room = rooms.get(peer.roomId);
  if (!room) return;
  // Excludes the sender — same as peer-device-switched, the broadcaster already knows their own
  // state locally. This is purely so viewers get an authoritative "stopped" they can trust even
  // if the underlying WebRTC track never fires its own 'ended' event (see messages.ts).
  broadcast(room, { type: 'peer-screen-share-changed', roomId: room.id, peerId: peer.id, isSharing }, peer.id);
}

export function handleDisconnect(socket: WebSocket): void {
  const peer = peersBySocket.get(socket);
  if (!peer) return;
  peersBySocket.delete(socket);

  const room = rooms.get(peer.roomId);
  if (!room) return;
  room.peers.delete(peer.id);

  if (room.peers.size === 0) {
    rooms.delete(room.id);
    return;
  }

  broadcast(room, { type: 'peer-left', roomId: room.id, peerId: peer.id });

  if (room.hostPeerId === peer.id) {
    startMigration(room);
  }
}

/**
 * Notifies up to CANDIDATE_BATCH_SIZE peers (ranked by connection uptime — decisions.md's
 * stability criterion) in parallel; the first to confirm within CONFIRM_TIMEOUT_MS wins. If
 * none confirm, cascades to the next batch. Once every peer has been tried, the room ends.
 */
function startMigration(room: Room, alreadyTried: string[] = []): void {
  const candidates = [...room.peers.values()]
    .filter((p) => !alreadyTried.includes(p.id))
    .sort((a, b) => a.joinedAt - b.joinedAt);

  if (candidates.length === 0) {
    broadcast(room, { type: 'room-closed', roomId: room.id });
    rooms.delete(room.id);
    return;
  }

  const batch = candidates.slice(0, CANDIDATE_BATCH_SIZE);
  room.epoch += 1;
  const epoch = room.epoch;

  const timer = setTimeout(() => {
    if (room.pendingMigration?.epoch !== epoch) return; // already resolved by a confirmation
    room.pendingMigration = null;
    startMigration(room, [...alreadyTried, ...batch.map((p) => p.id)]);
  }, CONFIRM_TIMEOUT_MS);

  room.pendingMigration = { epoch, batch: batch.map((p) => p.id), timer };

  for (const candidate of batch) {
    send(candidate.socket, { type: 'host-candidate-notify', roomId: room.id, epoch });
  }
}
