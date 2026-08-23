import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type {
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

export function joinRoom(socket: WebSocket, roomId: string, displayName: string): void {
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
  // displayName comes from an untrusted client and is rebroadcast to strangers in the room —
  // trim/cap it rather than trusting it verbatim.
  const safeDisplayName = displayName.trim().slice(0, 60) || 'Peer';
  const peer: Peer = { id: randomUUID(), socket, roomId, joinedAt: Date.now(), displayName: safeDisplayName };
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
    peers: existingPeers.map((p) => ({ peerId: p.id, displayName: p.displayName }))
  });

  broadcast(room, { type: 'peer-joined', roomId, peerId: peer.id, displayName: safeDisplayName }, peer.id);
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
