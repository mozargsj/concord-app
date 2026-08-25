export interface JoinRoomMessage {
  type: 'join-room';
  roomId: string;
  displayName: string;
  userId: string;
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

/** Mic mute / deafen leave no observable trace for other peers (mute is just track.enabled =
 * false locally, deafen is local playback suppression) — broadcast explicitly so everyone can
 * show the right "not listening/speaking" indicator next to that participant's name. */
export interface MicStateMessage {
  type: 'mic-state';
  isMicMuted: boolean;
  isDeafened: boolean;
}

/** Explicit signal that screen sharing started/stopped — the WebRTC-level signal alone (the
 * remote track ending after RTCRtpSender.removeTrack + renegotiation) turned out unreliable in
 * testing: viewers kept the tile up with the last frame frozen instead of it disappearing when
 * the broadcaster stopped. This is authoritative for "stopped" regardless of what the track
 * object itself does. */
export interface ScreenShareChangedMessage {
  type: 'screen-share-changed';
  isSharing: boolean;
}

export type ClientToServerMessage =
  | JoinRoomMessage
  | SdpOfferMessage
  | SdpAnswerMessage
  | IceCandidateMessage
  | HostHeartbeatMessage
  | HostCandidateConfirmMessage
  | PingMessage
  | DeviceSwitchedMessage
  | MicStateMessage
  | ScreenShareChangedMessage;

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
  peers: { peerId: string; displayName: string; userId: string }[];
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
  userId: string;
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

export interface PeerMicStateMessage {
  type: 'peer-mic-state';
  roomId: string;
  peerId: string;
  isMicMuted: boolean;
  isDeafened: boolean;
}

export interface PeerScreenShareChangedMessage {
  type: 'peer-screen-share-changed';
  roomId: string;
  peerId: string;
  isSharing: boolean;
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
  | PeerDeviceSwitchedMessage
  | PeerMicStateMessage
  | PeerScreenShareChangedMessage;
