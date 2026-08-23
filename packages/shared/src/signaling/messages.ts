export interface JoinRoomMessage {
  type: 'join-room';
  roomId: string;
  displayName: string;
}

export interface SdpOfferMessage {
  type: 'sdp-offer';
  targetPeerId: string;
  sdp: string;
}

export interface SdpAnswerMessage {
  type: 'sdp-answer';
  targetPeerId: string;
  sdp: string;
}

export interface IceCandidateMessage {
  type: 'ice-candidate';
  targetPeerId: string;
  candidate: string;
}

export interface HostHeartbeatMessage {
  type: 'host-heartbeat';
  roomId: string;
  epoch: number;
}

export interface HostCandidateNotifyMessage {
  type: 'host-candidate-notify';
  roomId: string;
  epoch: number;
}

export interface HostCandidateConfirmMessage {
  type: 'host-candidate-confirm';
  roomId: string;
  epoch: number;
}

/** Generic RTT probe, independent of host-heartbeat (which is only sent by the host, for migration timing) — every peer needs its own latency reading. */
export interface PingMessage {
  type: 'ping';
  nonce: string;
}

export type DeviceKind = 'mic' | 'speaker';

/** Device switches leave no observable trace for other peers (same track, or an invisible replaceTrack) — broadcast explicitly so everyone can play the notification sound. */
export interface DeviceSwitchedMessage {
  type: 'device-switched';
  kind: DeviceKind;
}

export type ClientToServerMessage =
  | JoinRoomMessage
  | SdpOfferMessage
  | SdpAnswerMessage
  | IceCandidateMessage
  | HostHeartbeatMessage
  | HostCandidateConfirmMessage
  | PingMessage
  | DeviceSwitchedMessage;

/** Relayed to the target peer with the sender's id attached, since the client-to-server shape has no envelope. */
export interface SdpOfferRelayMessage extends SdpOfferMessage {
  fromPeerId: string;
}

export interface SdpAnswerRelayMessage extends SdpAnswerMessage {
  fromPeerId: string;
}

export interface IceCandidateRelayMessage extends IceCandidateMessage {
  fromPeerId: string;
}

/** Sent to a client right after it joins: its own id, the current host, epoch, and who else is already in the room. */
export interface RoomJoinedMessage {
  type: 'room-joined';
  roomId: string;
  peerId: string;
  hostPeerId: string;
  epoch: number;
  peers: { peerId: string; displayName: string }[];
}

export interface JoinRejectedMessage {
  type: 'join-rejected';
  roomId: string;
  reason: 'room-full';
}

export interface PeerJoinedMessage {
  type: 'peer-joined';
  roomId: string;
  peerId: string;
  displayName: string;
}

export interface PeerLeftMessage {
  type: 'peer-left';
  roomId: string;
  peerId: string;
}

export interface HostChangedMessage {
  type: 'host-changed';
  roomId: string;
  hostPeerId: string;
  epoch: number;
}

export interface RoomClosedMessage {
  type: 'room-closed';
  roomId: string;
}

export interface PongMessage {
  type: 'pong';
  nonce: string;
}

export interface PeerDeviceSwitchedMessage {
  type: 'peer-device-switched';
  roomId: string;
  peerId: string;
  kind: DeviceKind;
}

export type ServerToClientMessage =
  | RoomJoinedMessage
  | JoinRejectedMessage
  | SdpOfferRelayMessage
  | SdpAnswerRelayMessage
  | IceCandidateRelayMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | HostCandidateNotifyMessage
  | HostChangedMessage
  | RoomClosedMessage
  | PongMessage
  | PeerDeviceSwitchedMessage;
