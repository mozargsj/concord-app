import { useEffect, useRef, useState } from 'react';
import type { DeviceKind, ServerToClientMessage } from '@concord/shared';
import { SignalingClient, type SignalingStatus } from '../lib/signalingClient';
import { MeshManager } from '../lib/webrtcMesh';
import { getPreferredDeviceId } from '../lib/devicePreferences';
import { playDeviceSwitch, playRoomJoin, playRoomLeave } from '../lib/soundEffects';
import { TEST_OFFLINE } from '../lib/api';
import { fetchImageBytes, loadCachedImage, saveCachedImage, type ImageCacheKind } from '../lib/imageCache';

/** The server the joined room belongs to — just enough to know who to ask for its icon (its
 * owner) and, if that owner happens to be me, what to answer with. */
interface RoomServerInfo {
  id: string;
  ownerUserId: string;
  iconUrl: string | null;
}

const MIC_CONSTRAINTS = (preferredDeviceId: string | null): MediaTrackConstraints => ({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  ...(preferredDeviceId ? { deviceId: { exact: preferredDeviceId } } : {})
});

const PING_INTERVAL_MS = 4000;

export interface RoomPeer {
  peerId: string;
  userId: string;
  displayName: string;
  personalStream: MediaStream | null;
  screenStream: MediaStream | null;
  isSpeaking: boolean;
  isMicMuted: boolean;
  isDeafened: boolean;
  /** Only ever set after a successful P2P fetch from this peer (see requestImage in
   * webrtcMesh.ts) — null until then, even if the peer has an avatar set, since there's no
   * central store this could come from otherwise (decisions.md). */
  avatarUrl: string | null;
}

interface RoomConnectionState {
  connectionStatus: SignalingStatus | 'idle';
  selfPeerId: string | null;
  hostPeerId: string | null;
  peers: RoomPeer[];
  latencyMs: number | null;
  selfIsSpeaking: boolean;
}

const initialState: RoomConnectionState = {
  connectionStatus: 'idle',
  selfPeerId: null,
  hostPeerId: null,
  peers: [],
  latencyMs: null,
  selfIsSpeaking: false
};

/**
 * Owns the signaling connection + WebRTC mesh for the currently-joined room. Lives in
 * ServerListPage (not RoomView) because RoomSidebar also needs the real peer roster and
 * hostPeerId for the joined room — same "elevated to feed two places at once" pattern
 * already used for isSpeaking/latencyMs.
 */
export function useRoomConnection(
  roomId: string | null,
  displayName: string,
  userId: string,
  isMicMuted: boolean,
  isDeafened: boolean,
  myAvatarUrl: string | null,
  server: RoomServerInfo | null,
  onServerIconReceived: (serverId: string, url: string) => void
) {
  const [state, setState] = useState<RoomConnectionState>(initialState);
  const meshRef = useRef<MeshManager | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  // Read inside the onImageRequest/requestPeerImages callbacks (created once per room
  // connection) — refs keep them seeing the latest value without needing to recreate the mesh
  // every time one changes, same trick as every other prop this hook watches via a side effect.
  const myAvatarUrlRef = useRef(myAvatarUrl);
  const serverRef = useRef(server);
  const onServerIconReceivedRef = useRef(onServerIconReceived);

  useEffect(() => {
    myAvatarUrlRef.current = myAvatarUrl;
  }, [myAvatarUrl]);
  useEffect(() => {
    serverRef.current = server;
  }, [server]);
  useEffect(() => {
    onServerIconReceivedRef.current = onServerIconReceived;
  }, [onServerIconReceived]);

  /** Answers another peer's request for my avatar, or my server's icon if the request's
   * ownerId is a server I actually own — shared by both the offline-test and real mesh below. */
  async function onImageRequest(
    kind: ImageCacheKind,
    ownerId: string,
    knownHash: string | null
  ): Promise<
    { status: 'unchanged' } | { status: 'missing' } | { status: 'data'; data: ArrayBuffer; mimeType: string; hash: string }
  > {
    const server = serverRef.current;
    const url =
      kind === 'avatar'
        ? ownerId === userId
          ? myAvatarUrlRef.current
          : null
        : server && server.id === ownerId && server.ownerUserId === userId
          ? server.iconUrl
          : null;
    if (!url) return { status: 'missing' };
    const fetched = await fetchImageBytes(url);
    if (!fetched) return { status: 'missing' };
    if (knownHash && knownHash === fetched.hash) return { status: 'unchanged' };
    return { status: 'data', ...fetched };
  }

  /** A P2P download finished — cache it to disk and fold it into whichever piece of UI state
   * cares (a peer's roster entry, or the joined room's server icon). */
  function onImageReceived(kind: ImageCacheKind, ownerId: string, data: ArrayBuffer, mimeType: string): void {
    void saveCachedImage(kind, ownerId, data, mimeType).then(({ url }) => {
      if (kind === 'avatar') {
        setState((prev) => ({
          ...prev,
          peers: prev.peers.map((peer) => (peer.userId === ownerId ? { ...peer, avatarUrl: url } : peer))
        }));
      } else {
        onServerIconReceivedRef.current(ownerId, url);
      }
    });
  }

  /** Fires once per newly-known peer — asks them for their own avatar, and (if they're the
   * joined room's server owner) for the server's icon too. requestImage no-ops harmlessly if
   * the peer never answers (e.g. they have no avatar, or aren't really the owner). */
  function requestPeerImages(mesh: MeshManager, peerId: string, peerUserId: string): void {
    void loadCachedImage('avatar', peerUserId).then((cached) => {
      mesh.requestImage(peerId, 'avatar', peerUserId, cached?.hash ?? null);
    });
    const server = serverRef.current;
    if (!server || server.ownerUserId !== peerUserId) return;
    void loadCachedImage('server-icon', server.id).then((cached) => {
      mesh.requestImage(peerId, 'server-icon', server.id, cached?.hash ?? null);
    });
  }

  useEffect(() => {
    if (!roomId) {
      setState(initialState);
      return;
    }

    let cancelled = false;

    // [MODO TESTE OFFLINE — TEMPORÁRIO] Sem WebSocket real nenhum — simula "conectado e sozinho
    // na sala" na hora, sem depender de nenhum servidor (nem local nem produção). Câmera/mic/
    // detecção de fala continuam reais (getUserMedia + AnalyserNode são 100% locais); só não tem
    // ninguém pra mandar/receber mídia de verdade, já que não existe conexão de sinalização pra
    // descobrir outro peer.
    if (TEST_OFFLINE) {
      const mesh = new MeshManager({
        send: () => {},
        onRemoteStreamsChange: () => {},
        onSpeakingChange: () => {},
        onLocalSpeakingChange: (isSpeaking) => {
          setState((prev) => ({ ...prev, selfIsSpeaking: isSpeaking }));
        },
        onImageRequest,
        onImageReceived
      });
      meshRef.current = mesh;

      const selfPeerId = 'offline-self';
      setState((prev) => ({
        ...prev,
        connectionStatus: 'connected',
        selfPeerId,
        hostPeerId: selfPeerId,
        peers: [],
        latencyMs: 0
      }));

      let localMicStream: MediaStream | null = null;
      const preferredMic = getPreferredDeviceId('audioinput');
      navigator.mediaDevices
        .getUserMedia({ audio: MIC_CONSTRAINTS(preferredMic) })
        .then((stream) => {
          if (cancelled) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          localMicStream = stream;
          micStreamRef.current = stream;
          const track = stream.getAudioTracks()[0] ?? null;
          mesh.setLocalMicTrack(track);
        })
        .catch(() => {
          // No mic available/denied — proceed without local audio (video-only participation).
        });

      return () => {
        cancelled = true;
        mesh.closeAll();
        localMicStream?.getTracks().forEach((track) => track.stop());
        micStreamRef.current = null;
        meshRef.current = null;
      };
    }

    const signaling = new SignalingClient();
    signalingRef.current = signaling;
    const pendingPings = new Map<string, number>();

    const mesh = new MeshManager({
      send: (message) => signaling.send(message),
      onRemoteStreamsChange: (peerId, streams) => {
        setState((prev) => ({
          ...prev,
          peers: prev.peers.map((peer) =>
            peer.peerId === peerId
              ? { ...peer, personalStream: streams.personal, screenStream: streams.screen }
              : peer
          )
        }));
      },
      onSpeakingChange: (peerId, isSpeaking) => {
        setState((prev) => ({
          ...prev,
          peers: prev.peers.map((peer) => (peer.peerId === peerId ? { ...peer, isSpeaking } : peer))
        }));
      },
      onLocalSpeakingChange: (isSpeaking) => {
        setState((prev) => ({ ...prev, selfIsSpeaking: isSpeaking }));
      },
      onImageRequest,
      onImageReceived
    });
    meshRef.current = mesh;

    // Both guarded by `cancelled` — closing a WebSocket is async (ws.onclose fires on a
    // later tick), so a leftover event from the room just left can otherwise arrive after
    // this effect has already torn down and a new one started, stomping the new room's
    // fresh 'idle'/'connecting' status back to 'disconnected' and tripping ServerListPage's
    // unexpected-drop effect — kicking you straight back out of the room you just rejoined.
    signaling.onStatusChange((status) => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, connectionStatus: status }));
    });

    signaling.onMessage((message: ServerToClientMessage) => {
      if (cancelled) return;
      switch (message.type) {
        case 'room-joined':
          setState((prev) => ({
            ...prev,
            selfPeerId: message.peerId,
            hostPeerId: message.hostPeerId,
            peers: message.peers.map((peer) => ({
              peerId: peer.peerId,
              userId: peer.userId,
              displayName: peer.displayName,
              personalStream: null,
              screenStream: null,
              isSpeaking: false,
              isMicMuted: false,
              isDeafened: false,
              avatarUrl: null
            }))
          }));
          for (const peer of message.peers) {
            mesh.addExistingPeer(peer.peerId);
            requestPeerImages(mesh, peer.peerId, peer.userId);
          }
          break;
        case 'peer-joined':
          playRoomJoin();
          setState((prev) => ({
            ...prev,
            peers: [
              ...prev.peers,
              {
                peerId: message.peerId,
                userId: message.userId,
                displayName: message.displayName,
                personalStream: null,
                screenStream: null,
                isSpeaking: false,
                isMicMuted: false,
                isDeafened: false,
                avatarUrl: null
              }
            ]
          }));
          requestPeerImages(mesh, message.peerId, message.userId);
          break;
        case 'peer-left':
          playRoomLeave();
          mesh.removePeer(message.peerId);
          setState((prev) => ({ ...prev, peers: prev.peers.filter((peer) => peer.peerId !== message.peerId) }));
          break;
        case 'sdp-offer':
          void mesh.handleOffer(message.fromPeerId, message.sdp);
          break;
        case 'sdp-answer':
          void mesh.handleAnswer(message.fromPeerId, message.sdp);
          break;
        case 'ice-candidate':
          void mesh.handleIceCandidate(message.fromPeerId, message.candidate);
          break;
        case 'host-changed':
          setState((prev) => ({ ...prev, hostPeerId: message.hostPeerId }));
          break;
        case 'room-closed':
        case 'join-rejected':
          mesh.closeAll();
          setState((prev) => ({ ...prev, connectionStatus: 'disconnected' }));
          break;
        case 'pong': {
          const sentAt = pendingPings.get(message.nonce);
          if (sentAt !== undefined) {
            pendingPings.delete(message.nonce);
            setState((prev) => ({ ...prev, latencyMs: Math.round(performance.now() - sentAt) }));
          }
          break;
        }
        case 'peer-device-switched':
          playDeviceSwitch(message.kind);
          break;
        case 'peer-mic-state':
          setState((prev) => ({
            ...prev,
            peers: prev.peers.map((peer) =>
              peer.peerId === message.peerId
                ? { ...peer, isMicMuted: message.isMicMuted, isDeafened: message.isDeafened }
                : peer
            )
          }));
          break;
      }
    });

    let localMicStream: MediaStream | null = null;
    const preferredMic = getPreferredDeviceId('audioinput');
    navigator.mediaDevices
      .getUserMedia({ audio: MIC_CONSTRAINTS(preferredMic) })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        localMicStream = stream;
        micStreamRef.current = stream;
        const track = stream.getAudioTracks()[0] ?? null;
        mesh.setLocalMicTrack(track);
      })
      .catch(() => {
        // No mic available/denied — proceed without local audio (video-only participation).
      });

    signaling.connect(import.meta.env.VITE_SIGNALING_URL, roomId, displayName, userId);

    const pingInterval = setInterval(() => {
      const nonce = Math.random().toString(36).slice(2);
      pendingPings.set(nonce, performance.now());
      signaling.send({ type: 'ping', nonce });
    }, PING_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(pingInterval);
      mesh.closeAll();
      localMicStream?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
      signaling.close();
      meshRef.current = null;
      signalingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only roomId should trigger reconnect
  }, [roomId]);

  useEffect(() => {
    meshRef.current?.setMicMuted(isMicMuted);
  }, [isMicMuted]);

  // Lets every other client show a "not listening/speaking" indicator next to this peer's
  // name, same spot as the live-broadcast badge — no-op (send is null) outside a room or in
  // the offline test profile, same as everything else signaling-dependent.
  useEffect(() => {
    signalingRef.current?.send({ type: 'mic-state', isMicMuted, isDeafened });
  }, [isMicMuted, isDeafened]);

  function setLocalCameraTrack(track: MediaStreamTrack | null): void {
    void meshRef.current?.setLocalCameraTrack(track);
  }

  function setLocalScreenTrack(stream: MediaStream | null): void {
    void meshRef.current?.setLocalScreenTrack(stream);
  }

  /** Broadcasts the switch to the room (everyone else's client plays the sound) and plays it locally right away. */
  function sendDeviceSwitched(kind: DeviceKind): void {
    signalingRef.current?.send({ type: 'device-switched', kind });
    playDeviceSwitch(kind);
  }

  async function switchMicDevice(deviceId: string): Promise<void> {
    const mesh = meshRef.current;
    if (!mesh) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS(deviceId) });
      const newTrack = stream.getAudioTracks()[0] ?? null;
      if (!newTrack) return;
      const oldStream = micStreamRef.current;
      micStreamRef.current = stream;
      mesh.setLocalMicTrack(newTrack);
      oldStream?.getTracks().forEach((track) => track.stop());
      sendDeviceSwitched('mic');
    } catch {
      // device swap failed — keep using the previous mic track
    }
  }

  return {
    connectionStatus: state.connectionStatus,
    selfPeerId: state.selfPeerId,
    hostPeerId: state.hostPeerId,
    peers: state.peers,
    latencyMs: state.latencyMs,
    selfIsSpeaking: state.selfIsSpeaking,
    setLocalCameraTrack,
    setLocalScreenTrack,
    switchMicDevice,
    sendDeviceSwitched
  };
}
