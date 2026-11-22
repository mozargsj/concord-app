/** Profile presence status (remote-control spec 13.5): only 'online' can receive control requests
 * or offers; 'offline' just means "not reachable" — the user is still in the room. */
export type PresenceStatus = 'online' | 'busy' | 'unavailable' | 'offline';

/** How a room carries audio and video. 'mesh' = P2P between every pair (default); 'sfu' = through
 * the Cloudflare Realtime SFU. Only the server decides (servers.media_mode in D1, fixed while the
 * room has people); the client never chooses it. Data channels (chat, images, sounds, remote control,
 * files) stay P2P in both modes. */
export type MediaMode = 'mesh' | 'sfu';

/** One published track in SFU mode — same roles the mesh uses for its senders. */
export type SfuTrackRole = 'mic' | 'camera' | 'screenVideo' | 'screenAudio' | 'musicAudio';

// ---- Server presence (/presence-ws?serverId=) — who is in each room of a server, for members
// who are not in that room. Separate socket from the room signaling: one per open server.

export interface PresencePeer {
  userId: string;
  displayName: string;
}

/** The only client→server message on the presence socket: authenticates, then the server answers
 * with a snapshot and keeps pushing per-room changes. */
export interface PresenceSubscribeMessage {
  type: 'presence-subscribe';
  sessionToken: string;
}

export type PresenceServerMessage =
  /** Every room of the server that has someone in it (absent roomId = empty room). */
  | { type: 'presence-snapshot'; rooms: Record<string, PresencePeer[]> }
  /** One room's full current list (empty array = room emptied). */
  | { type: 'presence-room'; roomId: string; peers: PresencePeer[] };

export interface JoinRoomMessage {
  type: 'join-room';
  roomId: string;
  /** Server the room belongs to — the signaling server uses this + sessionToken to confirm the
   * joiner is actually a member of that server before letting them into the room (see
   * roomManager.ts). Without it there was no way to check room membership at all. */
  serverId: string;
  displayName: string;
  /** Client-claimed identity — only trusted as a fallback when sessionToken doesn't verify AND
   * the server has ALLOW_UNAUTHENTICATED_ROOMS set (local/test-dev signaling only, never
   * production — see env.ts). Otherwise the server derives the real userId from sessionToken and
   * ignores this field entirely. */
  userId: string;
  /** Verified server-side via verifySessionToken (auth/session.ts) — same token already used for
   * every HTTP call. Before this, join-room had no session check at all: anyone who knew/guessed
   * a roomId could join and claim any userId. */
  sessionToken: string;
  /** Last status the user picked (persisted client-side); the server defaults to 'online'. */
  status?: PresenceStatus;
  /** True on clients that can run media through the SFU. Older clients omit it, and the server
   * refuses them from an SFU room ('update-required') instead of letting a mixed room form. */
  sfuCapable?: boolean;
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

/** [2026-08-30, pedido do Mozar] Mesmo papel do screen-share-changed acima, só que pra
 * "compartilhar áudio" (transmite só o áudio de um app escolhido, via WASAPI process-loopback em
 * modo INCLUDE — ver process_loopback.cc). Sinal explícito pela mesma razão: o evento nativo da
 * track (`onended`) não é confiável o bastante sozinho pra saber quando parou. */
export interface MusicShareChangedMessage {
  type: 'music-share-changed';
  isSharing: boolean;
}

/** Avatar images are P2P-only (never touch this server, see decisions.md §3) — a peer only ever
 * asks another for their avatar once, right when that peer is first seen (requestPeerImages in
 * useRoomConnection.ts). Changing the picture mid-call leaves no observable trace of its own
 * (no track, no state flag), so without this, everyone already connected keeps showing the old
 * one until they leave and rejoin. Same "no other signal exists" rationale as device-switched
 * above — broadcast explicitly so already-connected peers know to ask again. */
export interface AvatarChangedMessage {
  type: 'avatar-changed';
}

/** "Mutar pra mim" (usePeerVolumeControl.ts) sempre foi 100% local — nunca saía do cliente, então
 * quem mutava ninguém mais ficava sabendo (decisions.md, "Pontos ainda em aberto"). Diferente de
 * mic-state (broadcast — todo mundo precisa saber se alguém está mutado/deafened), esse é dirigido
 * (targetPeerId + relay com fromPeerId), mesmo padrão de sdp-offer/ice-candidate: só o alvo
 * precisa saber que foi mutado por alguém específico, pra acender o próprio badge "fulano te
 * mutou" só na tela de quem foi mutado. */
export interface PeerMuteStatusMessage {
  type: 'peer-mute-status';
  targetPeerId: string;
  isMuted: boolean;
}

/** Same "no other signal exists" rationale as avatar-changed — server icons are P2P-only
 * (decisions.md), so a peer already sharing a room with the server's owner never finds out the
 * icon changed on its own (unlike avatars, no WebRTC-level event fires for this at all). Only the
 * owner ever sends this (useRoomConnection.ts checks ownerUserId before sending) — serverId is
 * included because, unlike userId for avatar-changed, the DO never tracks which server a room
 * belongs to (join-room's serverId is checked once, at join, then discarded). */
export interface ServerIconChangedMessage {
  type: 'server-icon-changed';
  serverId: string;
}

export interface StatusChangedMessage {
  type: 'status-changed';
  status: PresenceStatus;
}

// ---- SFU mode (MediaMode 'sfu') -------------------------------------------------------------
// The client never talks to the Cloudflare API: it sends its SDP here, the room's Durable Object
// calls the API with the app secret and answers with 'sfu-result' (matched by requestId). Each
// client keeps two RTCPeerConnections to the SFU: one publishes (client offers), one subscribes
// (SFU offers). `fresh` asks the server for a new SFU session on that side (first use, or after
// the client rebuilt a failed connection).

/** Publishes new local tracks: the publisher connection's offer plus the mid of each new track. */
export interface SfuPublishMessage {
  type: 'sfu-publish';
  requestId: string;
  fresh: boolean;
  sdp: string;
  tracks: { mid: string; role: SfuTrackRole }[];
}

/** Stops published tracks (their transceivers already stopped in this offer). */
export interface SfuUnpublishMessage {
  type: 'sfu-unpublish';
  requestId: string;
  sdp: string;
  mids: string[];
}

/** Pulls other peers' tracks onto the subscriber connection. The server resolves each peerId to
 * that peer's SFU session; the answer carries the SFU's offer and the mid of each track. */
export interface SfuSubscribeMessage {
  type: 'sfu-subscribe';
  requestId: string;
  fresh: boolean;
  tracks: { peerId: string; trackName: string }[];
}

/** The subscriber connection's answer to the offer that came back in the last 'sfu-subscribe'. */
export interface SfuRenegotiateMessage {
  type: 'sfu-renegotiate';
  requestId: string;
  sdp: string;
}

/** Drops subscriptions (mids on the subscriber connection) for tracks that ended. */
export interface SfuUnsubscribeMessage {
  type: 'sfu-unsubscribe';
  requestId: string;
  mids: string[];
}

export type ClientToServerMessage =
  | SfuPublishMessage
  | SfuUnpublishMessage
  | SfuSubscribeMessage
  | SfuRenegotiateMessage
  | SfuUnsubscribeMessage
  | JoinRoomMessage
  | StatusChangedMessage
  | SdpOfferMessage
  | SdpAnswerMessage
  | IceCandidateMessage
  | HostHeartbeatMessage
  | HostCandidateConfirmMessage
  | PingMessage
  | DeviceSwitchedMessage
  | MicStateMessage
  | ScreenShareChangedMessage
  | MusicShareChangedMessage
  | AvatarChangedMessage
  | PeerMuteStatusMessage
  | ServerIconChangedMessage;

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
  peers: { peerId: string; displayName: string; userId: string; status: PresenceStatus }[];
  /** Absent from servers older than SFU support — read as 'mesh'. */
  mediaMode?: MediaMode;
}

export interface JoinRejectedMessage {
  type: 'join-rejected';
  roomId: string;
  reason: 'room-full' | 'unauthorized' | 'forbidden' | 'update-required';
}

/** Answer to any SFU request, matched by requestId. `tracks` comes back for 'sfu-publish' and
 * 'sfu-subscribe' (per-track failures in `error`). */
export interface SfuResultMessage {
  type: 'sfu-result';
  requestId: string;
  ok: boolean;
  error?: string;
  sdp?: string;
  tracks?: { peerId?: string; trackName: string; mid?: string; error?: string }[];
}

/** The full current list of one peer's published SFU tracks — sent to everyone else whenever it
 * changes, and to a new joiner once per peer right after 'room-joined'. */
export interface PeerSfuTracksMessage {
  type: 'peer-sfu-tracks';
  roomId: string;
  peerId: string;
  tracks: { role: SfuTrackRole; trackName: string }[];
}

export interface PeerJoinedMessage {
  type: 'peer-joined';
  roomId: string;
  peerId: string;
  displayName: string;
  userId: string;
  status: PresenceStatus;
}

/** A user already in the room joined again (new connection, same userId) — the server keeps their
 * existing peerId/host role and just swaps in the new connection's data, instead of announcing a
 * peer-left + a brand-new peer-joined (which duplicated the participant and forced a host
 * migration when it was the host). Receivers must drop the old RTCPeerConnection for this peerId
 * (its transport died with the old socket) and keep the participant's entry in place. */
export interface PeerRejoinedMessage {
  type: 'peer-rejoined';
  roomId: string;
  peerId: string;
  displayName: string;
  userId: string;
  status: PresenceStatus;
}

export interface PeerStatusChangedMessage {
  type: 'peer-status-changed';
  roomId: string;
  peerId: string;
  status: PresenceStatus;
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

export interface PeerMusicShareChangedMessage {
  type: 'peer-music-share-changed';
  roomId: string;
  peerId: string;
  isSharing: boolean;
}

/** userId included directly (like peer-joined) rather than making the receiving client look one
 * up from its own peer list — avoids any dependency on that list being up to date at the moment
 * this arrives. */
export interface PeerAvatarChangedMessage {
  type: 'peer-avatar-changed';
  roomId: string;
  peerId: string;
  userId: string;
}

export interface PeerMuteStatusRelayMessage extends PeerMuteStatusMessage {
  fromPeerId: string;
}

export interface PeerServerIconChangedMessage {
  type: 'peer-server-icon-changed';
  roomId: string;
  peerId: string;
  serverId: string;
}

export type ServerToClientMessage =
  | SfuResultMessage
  | PeerSfuTracksMessage
  | RoomJoinedMessage
  | JoinRejectedMessage
  | SdpOfferRelayMessage
  | SdpAnswerRelayMessage
  | IceCandidateRelayMessage
  | PeerJoinedMessage
  | PeerRejoinedMessage
  | PeerStatusChangedMessage
  | PeerLeftMessage
  | HostCandidateNotifyMessage
  | HostChangedMessage
  | RoomClosedMessage
  | PongMessage
  | PeerDeviceSwitchedMessage
  | PeerMicStateMessage
  | PeerScreenShareChangedMessage
  | PeerMusicShareChangedMessage
  | PeerAvatarChangedMessage
  | PeerMuteStatusRelayMessage
  | PeerServerIconChangedMessage;
