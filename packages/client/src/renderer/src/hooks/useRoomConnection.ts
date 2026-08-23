import { useEffect, useRef, useState } from 'react';
import type { DeviceKind, ServerToClientMessage } from '@concord/shared';
import { SignalingClient, type SignalingStatus } from '../lib/signalingClient';
import { MeshManager } from '../lib/webrtcMesh';
import { getPreferredDeviceId } from '../lib/devicePreferences';
import { playDeviceSwitch, playRoomJoin } from '../lib/soundEffects';
import { TEST_OFFLINE } from '../lib/api';

const MIC_CONSTRAINTS = (preferredDeviceId: string | null): MediaTrackConstraints => ({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  ...(preferredDeviceId ? { deviceId: { exact: preferredDeviceId } } : {})
});

const PING_INTERVAL_MS = 4000;

export interface RoomPeer {
  peerId: string;
  displayName: string;
  personalStream: MediaStream | null;
  screenStream: MediaStream | null;
  isSpeaking: boolean;
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
export function useRoomConnection(roomId: string | null, displayName: string, isMicMuted: boolean) {
  const [state, setState] = useState<RoomConnectionState>(initialState);
  const meshRef = useRef<MeshManager | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

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
        }
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
          if (track) track.enabled = !isMicMuted;
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
      }
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
              displayName: peer.displayName,
              personalStream: null,
              screenStream: null,
              isSpeaking: false
            }))
          }));
          for (const peer of message.peers) mesh.addExistingPeer(peer.peerId);
          break;
        case 'peer-joined':
          playRoomJoin();
          setState((prev) => ({
            ...prev,
            peers: [
              ...prev.peers,
              {
                peerId: message.peerId,
                displayName: message.displayName,
                personalStream: null,
                screenStream: null,
                isSpeaking: false
              }
            ]
          }));
          break;
        case 'peer-left':
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
        if (track) track.enabled = !isMicMuted;
        mesh.setLocalMicTrack(track);
      })
      .catch(() => {
        // No mic available/denied — proceed without local audio (video-only participation).
      });

    signaling.connect(import.meta.env.VITE_SIGNALING_URL, roomId, displayName);

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
    meshRef.current?.setMicEnabled(!isMicMuted);
  }, [isMicMuted]);

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
      newTrack.enabled = !isMicMuted;
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
