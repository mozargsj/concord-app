export interface JoinRoomMessage {
  type: 'join-room';
  roomId: string;
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

export type ClientToServerMessage =
  | JoinRoomMessage
  | SdpOfferMessage
  | SdpAnswerMessage
  | IceCandidateMessage
  | HostCandidateConfirmMessage;

export type ServerToClientMessage =
  | SdpOfferMessage
  | SdpAnswerMessage
  | IceCandidateMessage
  | HostHeartbeatMessage
  | HostCandidateNotifyMessage;
